/** The text in a file tab, and the copy of the file that text is based on. */
export interface FileBuffer {
  content: string
  /**
   * The file as last taken from the disk. Unsaved edits hold on to the copy
   * they started from, so saving can tell when the file has moved on since.
   */
  original: string
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
  if (edited && !discardEdits && buffer.content !== disk) return buffer
  return { content: disk, original: disk }
}
