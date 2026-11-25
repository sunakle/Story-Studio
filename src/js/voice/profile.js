import { decodeWav } from './wav.js';

export const LINE_TARGET = '@selected-line';

export function voiceTarget(project, target, node) {
  if (target === LINE_TARGET && node) return node;
  return target ? project.characters.find(character => character.id === target) : project;
}

export function effectiveVoice(project, target, node) {
  const own = voiceTarget(project, target, node)?.voice;
  if (own) return own;
  if (target === LINE_TARGET && node?.speakerId) {
    const speaker = project.characters.find(character => character.id === node.speakerId);
    if (speaker?.voice) return speaker.voice;
  }
  return project.voice || { preset: 0, params: {} };
}

export function voiceOperation(target, node, voice) {
  if (target === LINE_TARGET) return { op: 'setVoice', nodeId: node?.id || LINE_TARGET, voice };
  return { op: 'setVoice', ...(target && { id: target }), voice };
}

// Retain the previous hash for projects authored before explicit takes existed.
export function takeSeed(node, voice) {
  if (Number.isInteger(node?.voiceSeed)) return node.voiceSeed;
  if (Number.isInteger(voice?.seed)) return voice.seed;
  if (!node) return 1;
  const text = node.id + node.text;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = (hash ^ text.charCodeAt(i)) * 16777619;
  return Math.abs(hash | 0) || 1;
}

// A single decoded clip shared by both voice panels. Project JSON holds only
// the original WAV bytes, including their sample rate, bit depth and channels.
let cachedData;
let cachedAudio;

export function packSample(input, name) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const audio = decodeWav(bytes);
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    pieces.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  const data = btoa(pieces.join(''));
  cachedData = data;
  cachedAudio = audio;
  return { name: String(name || 'sample.wav'), data };
}

export function sampleAudio(sample) {
  if (!sample?.data) return null;
  if (cachedData !== sample.data) {
    const binary = atob(sample.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    cachedAudio = decodeWav(bytes);
    cachedData = sample.data;
  }
  return cachedAudio;
}

export function clearSampleCache() {
  cachedAudio = cachedData = undefined;
}
