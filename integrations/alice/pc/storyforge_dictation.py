"""YaPanel client for the installed StoryForge editor's user-local dictation endpoint."""
from __future__ import annotations

import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time


ACTIONS = frozenset({'storyforge_start', 'storyforge_append', 'storyforge_stop', 'storyforge_status'})
ID = re.compile(r'[0-9a-f]{32}\Z')
TOKEN = re.compile(r'[0-9a-f]{64}\Z')
INNO_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\{9DBBB0F5-FB14-4458-8D51-C134636C8743}_is1'


def launch_installed():
    """Launch only the registered StoryForge installation, with no arguments from speech."""
    import winreg
    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, INNO_KEY, 0, winreg.KEY_READ | view) as key:
                folder = Path(winreg.QueryValueEx(key, 'InstallLocation')[0])
        except FileNotFoundError:
            continue
        if not folder.is_absolute() or folder.drive.startswith('\\\\'):
            raise ValueError('invalid local install')
        exe = folder / 'StoryForge.exe'
        metadata = json.loads((folder / 'resources/app/package.json').read_text(encoding='utf-8-sig'))
        if metadata.get('name') != 'storyforge' or metadata.get('productName') != 'StoryForge':
            raise ValueError('invalid StoryForge installation')
        subprocess.Popen([str(exe)], cwd=folder, shell=False, close_fds=True)
        return
    raise FileNotFoundError('StoryForge is not installed for this user')


def decode_command(value):
    command = value['action']
    session = value.get('session')
    if (command not in ACTIONS or value.get('target') != 'storyforge' or
            not isinstance(session, str) or not ID.fullmatch(session)):
        raise ValueError('invalid session')
    action = command.removeprefix('storyforge_')
    payload = {'action': action, 'session': session}
    if action == 'start' and value.get('id') != session:
        raise ValueError('invalid start')
    if action == 'append':
        seq, phrase = value.get('seq'), value.get('query')
        if type(seq) is not int or not 1 <= seq <= 2**53 - 1:
            raise ValueError('invalid sequence')
        if not isinstance(phrase, str) or not phrase.strip() or len(phrase) > 16000:
            raise ValueError('invalid utterance')
        payload.update(seq=seq, text=phrase)
    return payload


class StoryForgeDictation:
    def __init__(self, descriptor=None, launcher=launch_installed):
        self.descriptor = (Path(descriptor) if descriptor is not None else
                           Path(os.environ['LOCALAPPDATA']) / 'StoryForge/User Data/alice-dictation.json')
        self.launcher = launcher
        self.session = None
        self.endpoint = None

    def read_endpoint(self):
        with self.descriptor.open('rb') as handle:
            raw = handle.read(2049)
        if len(raw) > 2048:
            raise ValueError('invalid descriptor')
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError('invalid descriptor')
        port, token = data.get('port'), data.get('token')
        if (data.get('version') != 1 or type(port) is not int or not 1 <= port <= 65535
                or not isinstance(token, str) or not TOKEN.fullmatch(token)):
            raise ValueError('invalid descriptor')
        return port, token

    @staticmethod
    def post(endpoint, payload, timeout):
        port, token = endpoint
        # HTTPConnection neither follows redirects nor uses proxy/environment settings.
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        try:
            connection.request('POST', '/v1/dictation', json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                               {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            if response.status != 200:
                raise ValueError('editor rejected request')
            raw = response.read(2049)
            if len(raw) > 2048:
                raise ValueError('invalid reply')
            result = json.loads(raw)
            if not isinstance(result, dict) or type(result.get('ok')) is not bool:
                raise ValueError('invalid reply')
            return result
        finally:
            connection.close()

    def start(self, payload, expires):
        if self.session is not None and self.session != payload['session']:
            old_session = self.session
            if self.deliver({'action': 'status', 'session': old_session}, expires):
                return False
            self.session = self.endpoint = None
        deadline = min(expires, time.monotonic() + 14)
        launched = False
        while time.monotonic() < deadline:
            try:
                endpoint = self.read_endpoint()
                result = self.post(endpoint, payload, min(2, max(.1, deadline - time.monotonic())))
                if result.get('ok') and result.get('active') is True:
                    self.session, self.endpoint = payload['session'], endpoint
                    return True
                if result.get('code') != 'not_ready':
                    return False
            except (FileNotFoundError, ConnectionRefusedError):
                if not launched:
                    self.launcher()
                    launched = True
            except (TimeoutError, http.client.RemoteDisconnected, ConnectionResetError):
                pass  # The editor treats duplicate session starts idempotently.
            time.sleep(.15)
        return False

    def deliver(self, payload, expires):
        action = payload['action']
        if action == 'start':
            return self.start(payload, expires)
        if self.session != payload['session']:
            return action == 'stop'
        try:
            if self.read_endpoint() != self.endpoint:
                self.session = self.endpoint = None
                return False
            for attempt in range(2):
                remaining = expires - time.monotonic()
                if remaining <= 0:
                    return False
                try:
                    result = self.post(self.endpoint, payload, min(remaining, 2))
                    break
                except (TimeoutError, http.client.RemoteDisconnected, ConnectionResetError):
                    if attempt:
                        raise
            if action == 'stop':
                return result['ok'] or result.get('code') == 'inactive'
            if not result['ok'] or result.get('active') is not True:
                if result.get('code') == 'inactive':
                    self.session = self.endpoint = None
                return False
            return action != 'append' or result.get('lastSeq') == payload['seq']
        except (OSError, ValueError, http.client.HTTPException):
            self.session = self.endpoint = None
            return False
        finally:
            if action == 'stop':
                self.session = self.endpoint = None

    def execute(self, value, journal, *, wall=time.time):
        ident = value.get('id')
        if not isinstance(ident, str) or not ID.fullmatch(ident):
            raise ValueError('invalid command id')
        try:
            payload = decode_command(value)
            stamp = value.get('created_at')
            if type(stamp) not in (int, float) or not math.isfinite(stamp) or not 0 < stamp <= wall() + 5:
                raise ValueError('invalid timestamp')
        except (KeyError, ValueError):
            return ident, 'error'
        age = max(0, wall() - stamp)
        if age >= 60:
            return ident, 'expired'
        heartbeat = payload['action'] == 'status'
        if not heartbeat:
            encoded = json.dumps([ident, stamp, payload], sort_keys=True, separators=(',', ':')).encode('ascii')
            fingerprint = hashlib.sha256(encoded).hexdigest()
            previous = journal.entries.get(ident)
            if previous:
                return ident, previous['status'] if previous['fingerprint'] == fingerprint else 'unknown'
        try:
            status = 'ok' if self.deliver(payload, time.monotonic() + 60 - age) else 'error'
        except (OSError, ValueError, http.client.HTTPException):
            status = 'error'
        if not heartbeat:
            # Keep only opaque delivery receipts. The editor checks session and seq before editing.
            journal.put(ident, status, fingerprint)
        return ident, status
