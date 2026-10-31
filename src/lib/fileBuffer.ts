/** The text in a file tab, and the copy of the file that text is based on. */
export interface FileBuffer {
  content: string
  /**
   * The file as last taken from the disk. Unsaved edits hold on to the copy
   * they started from, so saving can tell when the file has moved on since.
   */
  original: string
  /** The file on disk is no longer `original`, under edits that are in the way. */
  diskChanged: boolean
}

/** A buffer with no edits, in step with the file. */
export const bufferOf = (text: string): FileBuffer => ({
  content: text,
  original: text,
  diskChanged: false,
})

/** Whether a text's lines mostly end in \r\n, for a file that mixes the two. */
function usesCrlf(text: string): boolean {
  let lines = 0
  let crlf = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    lines++
    if (text[i - 1] === '\r') crlf++
  }
  return crlf * 2 > lines
}

/**
 * Takes in text from the editor, which holds line ends as \n whatever the file
 * uses. They go back to the file's own here, or changing one line of a CRLF file
 * would rewrite all of them, and undoing the change would not leave it clean.
 */
export function applyEdit(buffer: FileBuffer, text: string): FileBuffer {
  return { ...buffer, content: usesCrlf(buffer.original) ? text.replace(/\n/g, '\r\n') : text }
}

/**
 * Brings a buffer up to date with what was just read from the disk.
 *
 * With no edits the tab simply shows the file. With edits the buffer is left
 * alone, base included: moving `original` forward here would hide the change
 * from the check made on saving, and the old text would overwrite the new.
 */
export function followDisk(buffer: FileBuffer, disk: string, discardEdits = false): FileBuffer {
  const edited = buffer.content !== buffer.original
  if (edited && !discardEdits && buffer.content !== disk) {
    return { ...buffer, diskChanged: disk !== buffer.original }
  }
  return bufferOf(disk)
}
