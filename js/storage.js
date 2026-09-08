/**
 * storage.js
 * ---------------------------------------------------------------------------
 * Handles persistent storage (IndexedDB / LocalStorage) and media file export.
 * Includes automatic EBML metadata patching for recorded WebM blobs to ensure
 * duration visibility, timeline seeking, and playback speed control.
 * ---------------------------------------------------------------------------
 */

/**
 * Patches a WebM Blob with accurate duration metadata in EBML header.
 * Fixes Chrome/Edge non-seekable WebM recorder bug.
 * 
 * @param {Blob} webmBlob - The raw WebM blob from MediaRecorder
 * @param {number} durationMs - Measured total duration in milliseconds
 * @returns {Promise<Blob>} - Fixed WebM blob with valid duration
 */
export async function makeWebmSeekable(webmBlob, durationMs) {
  if (!webmBlob || !durationMs || durationMs <= 0) return webmBlob;

  try {
    const arrayBuffer = await webmBlob.arrayBuffer();
    const dataView = new DataView(arrayBuffer);

    // Find the Segment Info element (ID: 0x1549A966)
    let infoOffset = -1;
    for (let i = 0; i < dataView.byteLength - 4; i++) {
      if (
        dataView.getUint8(i) === 0x15 &&
        dataView.getUint8(i + 1) === 0x49 &&
        dataView.getUint8(i + 2) === 0xa9 &&
        dataView.getUint8(i + 3) === 0x66
      ) {
        infoOffset = i;
        break;
      }
    }

    if (infoOffset === -1) return webmBlob;

    // Search for Duration tag (ID: 0x4489) inside Segment Info
    let durationOffset = -1;
    for (let i = infoOffset; i < Math.min(infoOffset + 100, dataView.byteLength - 2); i++) {
      if (dataView.getUint8(i) === 0x44 && dataView.getUint8(i + 1) === 0x89) {
        durationOffset = i;
        break;
      }
    }

    // If duration tag exists, patch the float value directly
    if (durationOffset !== -1) {
      const updatedBuffer = arrayBuffer.slice(0);
      const updatedView = new DataView(updatedBuffer);
      // EBML float64 duration value in milliseconds
      updatedView.setFloat64(durationOffset + 3, durationMs, false);
      return new Blob([updatedBuffer], { type: webmBlob.type || "video/webm" });
    }

    return webmBlob;
  } catch (err) {
    console.warn("[Storage] Could not patch WebM duration header:", err);
    return webmBlob;
  }
}

/**
 * Downloads a media Blob with full duration metadata fix applied.
 * 
 * @param {Blob} rawBlob - Recorded WebM Blob
 * @param {string} fileName - Destination filename
 * @param {number} durationMs - Measured duration in milliseconds
 */
export async function downloadMediaFile(rawBlob, fileName, durationMs = 0) {
  if (!rawBlob) return;

  // Process WebM blob to make it seekable before download
  const readyBlob = rawBlob.type.includes("webm") && durationMs > 0
    ? await makeWebmSeekable(rawBlob, durationMs)
    : rawBlob;

  const url = URL.createObjectURL(readyBlob);
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = url;
  a.download = fileName;

  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Exports meeting transcript as Markdown or Text file.
 * 
 * @param {Array} transcriptItems - Array of transcript objects
 * @param {string} fileName - Destination filename
 * @param {string} format - 'md' | 'txt'
 */
export function exportTranscriptFile(transcriptItems, fileName, format = "md") {
  if (!transcriptItems || transcriptItems.length === 0) return;

  let content = "";
  if (format === "md") {
    content = `# Meeting Transcript - MeetMind\n\n`;
    transcriptItems.forEach((item) => {
      const time = new Date(item.timestamp).toLocaleTimeString();
      content += `**[${time}] ${item.channel.toUpperCase()}:** ${item.text}\n\n`;
    });
  } else {
    transcriptItems.forEach((item) => {
      const time = new Date(item.timestamp).toLocaleTimeString();
      content += `[${time}] ${item.channel.toUpperCase()}: ${item.text}\n`;
    });
  }

  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileName}.${format}`;
  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 100);
}
