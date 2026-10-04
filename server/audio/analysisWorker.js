// Worker thread: runs song analysis and element production off the real-time audio thread.
import { parentPort } from 'node:worker_threads';
import { analyzeHead, analyzeTail, loudnessProfile, peaks } from './analysis.js';
import { renderTemplate, writeWav } from './productionDsp.js';
import { renderBedLoop } from './bedSynth.js';

parentPort.on('message', ({ id, cmd, buffer, opts }) => {
  try {
    const pcm = new Int16Array(buffer);
    let result;
    if (cmd === 'head') result = analyzeHead(pcm, opts);
    else if (cmd === 'tail') result = analyzeTail(pcm, opts);
    else if (cmd === 'loudness') result = { integrated: loudnessProfile(pcm).integrated };
    else if (cmd === 'peaks') result = { peaks: Array.from(peaks(pcm, opts?.res)) };
    else if (cmd === 'produce') result = renderTemplate({ ...opts, pcm });
    else if (cmd === 'bed') {
      const loop = renderBedLoop(opts.style);
      writeWav(opts.out, loop);
      result = { seconds: loop.seconds, bpm: loop.bpm, bars: loop.bars };
    }
    else throw new Error(`unknown command ${cmd}`);
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
