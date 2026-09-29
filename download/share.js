// Save / Share for a photo, used by the download page and the album.

/** The phone's share sheet when it can take files, otherwise a plain download. A cancelled share is not an error. */
export async function sharePhoto(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
      // Share failed for another reason: fall back to a plain download.
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
