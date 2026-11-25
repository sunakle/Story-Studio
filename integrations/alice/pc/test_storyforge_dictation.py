import http.server
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from storyforge_dictation import StoryForgeDictation


class Journal:
    def __init__(self):
        self.entries = {}

    def put(self, ident, status, fingerprint):
        self.entries[ident] = {'status': status, 'fingerprint': fingerprint}


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.descriptor = Path(self.temp.name) / 'endpoint.json'
        self.journal = Journal()
        self.session = 'a' * 32
        self.launches = 0
        self.active = False
        self.seq = 0
        self.lines = []
        self.requests = []
        self.cancelled = False
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                if self.path != '/v1/dictation' or self.headers.get('Authorization') != 'Bearer ' + 'a' * 64:
                    self.send_error(401)
                    return
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.requests.append(data['action'])
                ok = True
                if data['action'] == 'start' and not owner.cancelled:
                    owner.active = True
                elif data['action'] == 'stop':
                    owner.active = False
                elif not owner.active:
                    ok = False
                elif data['action'] == 'append':
                    if data['seq'] == owner.seq + 1:
                        owner.lines.append(data['text'])
                        owner.seq += 1
                    elif data['seq'] > owner.seq:
                        ok = False
                reply = {'ok': ok, 'active': owner.active, 'lastSeq': owner.seq}
                if not ok:
                    reply['code'] = 'out_of_order' if owner.active else 'inactive'
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(reply).encode())

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .05}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.bridge = StoryForgeDictation(self.descriptor, self.launch)

    def launch(self):
        self.launches += 1
        self.write_descriptor()

    def write_descriptor(self, token='a' * 64):
        self.descriptor.write_text(json.dumps({'version': 1, 'port': self.server.server_port, 'token': token}))

    def message(self, action, ident='b' * 32, **extra):
        return dict(id=self.session if action == 'start' else ident, session=self.session,
                    target='storyforge', action='storyforge_' + action, created_at=round(time.time()), **extra)

    def test_start_launches_once_and_delivers_literal_phrases_in_order(self):
        start = self.message('start')
        line = self.message('append', seq=1, query='Ира: «Открой окно».\nСергей: Хорошо.')
        self.assertEqual(self.bridge.execute(start, self.journal)[1], 'ok')
        self.assertEqual(self.bridge.execute(start, self.journal)[1], 'ok')
        self.assertEqual(self.launches, 1)
        self.assertEqual(self.bridge.execute(line, self.journal)[1], 'ok')
        self.assertEqual(self.bridge.execute(line, self.journal)[1], 'ok')
        self.assertEqual(self.bridge.execute(dict(line, query='Подмена'), self.journal)[1], 'unknown')
        self.assertEqual(self.bridge.execute(self.message('status', 'c' * 32), self.journal)[1], 'ok')
        self.assertEqual(self.lines, [line['query']])
        self.assertFalse(any(line['query'] in str(v) for v in self.journal.entries.values()))
        self.assertNotIn('c' * 32, self.journal.entries)
        self.assertEqual(self.bridge.execute(self.message('stop', 'd' * 32), self.journal)[1], 'ok')
        self.assertFalse(self.active)

    def test_button_stop_and_editor_restart_do_not_reactivate_session(self):
        self.write_descriptor()
        self.bridge.execute(self.message('start'), self.journal)
        self.active, self.cancelled = False, True
        self.assertEqual(self.bridge.execute(self.message('status'), self.journal)[1], 'error')
        self.assertEqual(self.bridge.execute(self.message('append', seq=1, query='Далее'), self.journal)[1], 'error')
        self.assertEqual(self.launches, 0)
        self.assertEqual(self.lines, [])
        self.cancelled = False
        self.session = 'e' * 32
        self.bridge.execute(self.message('start'), self.journal)
        self.write_descriptor('2' * 64)
        self.assertEqual(self.bridge.execute(self.message('append', 'f' * 32, seq=1, query='Нет'), self.journal)[1], 'error')
        self.assertNotIn('append', self.requests)

    def test_malformed_commands_never_reach_editor(self):
        good = self.message('append', seq=1, query='Сцена')
        for bad in [dict(good, session='x'), dict(good, target='other'), dict(good, seq=True),
                    dict(good, query=' '), dict(good, query='x' * 16001), dict(good, created_at=0),
                    dict(good, action='run_shell'), dict(good, created_at=float('nan'))]:
            self.assertEqual(self.bridge.execute(bad, self.journal)[1], 'error')
        expired = dict(self.message('start'), created_at=time.time() - 120)
        self.assertEqual(self.bridge.execute(expired, self.journal)[1], 'expired')
        self.assertEqual(self.launches, 0)
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
