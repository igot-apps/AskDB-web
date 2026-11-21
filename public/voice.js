// Voice typing: record from the microphone, convert to WAV, and transcribe via OpenRouter.
(function () {
  const VOICE_MODEL = 'google/gemini-3.8-flash';
  const MAX_SECONDS = 60;
  let recorder = null, stream = null, chunks = [], timer = null;

  async function start(onAutoStop) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      throw new Error("AskDB couldn't use your microphone. Check that one is connected, and in Windows Settings → Privacy & security → Microphone, turn on \"Let desktop apps access your microphone\".");
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start();
    timer = setTimeout(onAutoStop, MAX_SECONDS * 1000);
  }

  function stopRecording() {
    clearTimeout(timer);
    return new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') return resolve(null);
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        resolve(new Blob(chunks, { type: recorder.mimeType }));
        recorder = null; stream = null;
      };
      recorder.stop();
    });
  }

  function cancel() { stopRecording(); }

  // Decode any recorded format to 16 kHz mono 16-bit WAV (small and widely accepted).
  async function toWavBase64(blob) {
    const ctx = new AudioContext({ sampleRate: 16000 });
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close();
    const n = audio.length, chs = audio.numberOfChannels;
    const mono = new Float32Array(n);
    for (let c = 0; c < chs; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chs; }
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, mono[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { base64: btoa(bin), seconds: n / 16000 };
  }

  async function stopAndTranscribe(apiKey) {
    const blob = await stopRecording();
    if (!blob || !blob.size) return '';
    const { base64, seconds } = await toWavBase64(blob);
    if (seconds < 0.4) return '';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'AskDB' },
      body: JSON.stringify({
        model: VOICE_MODEL,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this voice recording exactly as spoken, in the language spoken. It is a question or request about a database. Return ONLY the transcript text with normal punctuation. If there is no speech, return nothing.' },
            { type: 'input_audio', input_audio: { data: base64, format: 'wav' } },
          ],
        }],
      }),
    });
    let body = null;
    try { body = await res.json(); } catch {}
    if (res.status === 401) throw new Error('Your OpenRouter key was not accepted. Check it in Settings (⚙).');
    if (res.status === 402) throw new Error('Your OpenRouter account is out of credits.');
    if (!res.ok || !body || body.error) throw new Error("Sorry, I couldn't turn your voice into text. Please try again.");
    const text = body.choices?.[0]?.message?.content || '';
    return String(text).trim().replace(/^["']|["']$/g, '');
  }

  window.voice = { start, stopAndTranscribe, cancel };
})();
