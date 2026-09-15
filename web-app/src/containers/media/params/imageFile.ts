/**
 * Reading an image the user picks, for an `image_ref` parameter.
 *
 * The value sent with a job is a data URL (`data:image/png;base64,...`): the
 * built-in engine takes `init_image`, `end_image` and `ref_images` exactly like
 * that (checked in its own web UI, 2026-09-15), and a data URL needs no file
 * path that another process might not be able to read.
 */

/** Big enough for any photo, small enough not to stall the page. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

export class ImageFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageFileError'
  }
}

export function readImageFileAsDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    return Promise.reject(
      new ImageFileError(`${file.name} is not an image. Choose a PNG, JPEG or WebP picture.`)
    )
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Promise.reject(
      new ImageFileError(`${file.name} is larger than 25 MB. Choose a smaller picture.`)
    )
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new ImageFileError(`Could not read ${file.name}.`))
    reader.readAsDataURL(file)
  })
}

/** Is this value an attached image (as opposed to nothing, or a path)? */
export function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image/')
}
