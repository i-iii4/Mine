/** Where the helper gets the file of a picture card. */
export type PictureFileSource = { pre_uploaded_id: string } | { image_url: string };

/**
 * The file of a picture card (SPEC_CLIPPER.md, «Файл картинки из браузера,
 * отказ сайта и причина ошибки», Б1): the bytes the browser already has when
 * `fromBrowser` uploads them, else the address the helper downloads, as
 * before. A failed or missing browser path never fails the save.
 */
export async function pictureFileSource(
  imageUrl: string,
  fromBrowser: (() => Promise<string | null>) | null,
): Promise<PictureFileSource> {
  if (fromBrowser) {
    try {
      const uploadId = await fromBrowser();
      if (uploadId) return { pre_uploaded_id: uploadId };
    } catch {
      // The helper downloads the file instead.
    }
  }
  return { image_url: imageUrl };
}
