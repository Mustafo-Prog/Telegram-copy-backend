// Inspect container headers rather than trusting a filename or a client supplied MIME type.
function detectAudioType(buffer, declaredType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) === 'OggS' &&
      (buffer.subarray(0, 256).includes(Buffer.from('OpusHead')) || buffer.subarray(0, 256).includes(Buffer.from('vorbis')))) return 'audio/ogg';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      buffer.subarray(0, 4096).includes(Buffer.from('webm')) && /^audio\/webm\b/i.test(declaredType)) return 'audio/webm';
  if (buffer.toString('ascii', 4, 8) === 'ftyp' && /^audio\/(mp4|x-m4a)\b/i.test(declaredType)) return 'audio/mp4';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}
module.exports = { detectAudioType };
