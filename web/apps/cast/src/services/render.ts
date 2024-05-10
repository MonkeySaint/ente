import { FILE_TYPE } from "@/media/file-type";
import { isHEICExtension, isNonWebImageFileExtension } from "@/media/formats";
import { scaledImageDimensions } from "@/media/image";
import { decodeLivePhoto } from "@/media/live-photo";
import { createHEICConvertComlinkWorker } from "@/media/worker/heic-convert";
import type { DedicatedHEICConvertWorker } from "@/media/worker/heic-convert.worker";
import { nameAndExtension } from "@/next/file";
import log from "@/next/log";
import type { ComlinkWorker } from "@/next/worker/comlink-worker";
import { shuffled } from "@/utils/array";
import { ensure } from "@/utils/ensure";
import { wait } from "@/utils/promise";
import ComlinkCryptoWorker from "@ente/shared/crypto";
import { ApiError } from "@ente/shared/error";
import HTTPService from "@ente/shared/network/HTTPService";
import {
    getCastFileURL,
    getCastThumbnailURL,
    getEndpoint,
} from "@ente/shared/network/api";
import type { AxiosResponse } from "axios";
import type { CastData } from "services/cast-data";
import { detectMediaMIMEType } from "services/detect-type";
import {
    EncryptedEnteFile,
    EnteFile,
    FileMagicMetadata,
    FilePublicMagicMetadata,
} from "types/file";
import { isChromecast } from "./chromecast";

/**
 * If we're using HEIC conversion, then this variable caches the comlink web
 * worker we're using to perform the actual conversion.
 */
let heicWorker: ComlinkWorker<typeof DedicatedHEICConvertWorker> | undefined;

/**
 * An async generator function that loops through all the files in the
 * collection, returning renderable image URLs to each that can be displayed in
 * a slideshow.
 *
 * Each time it resolves with a (data) URL for the slideshow image to show next.
 *
 * If there are no renderable image in the collection, the sequence ends by
 * yielding `{done: true}`.
 *
 * Otherwise when the generator reaches the end of the collection, it starts
 * from the beginning again. So the sequence will continue indefinitely for
 * non-empty collections.
 *
 * The generator ignores errors in the fetching and decoding of individual
 * images in the collection, skipping the erroneous ones and moving onward to
 * the next one.
 *
 * - It will however throw if there are errors when getting the collection
 *   itself. This can happen both the first time, or when we are about to loop
 *   around to the start of the collection.
 *
 * - It will also throw if three consecutive image fail.
 *
 * @param castData The collection to show and credentials to fetch the files
 * within it.
 */
export const imageURLGenerator = async function* (castData: CastData) {
    const { collectionKey, castToken } = castData;

    /**
     * Keep a FIFO queue of the URLs that we've vended out recently so that we
     * can revoke those that are not being shown anymore.
     */
    const previousURLs: string[] = [];

    /** Number of milliseconds to keep the slide on the screen. */
    const slideDuration = 12000; /* 12 s */

    /**
     * Time when we last yielded.
     *
     * We use this to keep an roughly periodic spacing between yields that
     * accounts for the time we spend fetching and processing the images.
     */
    let lastYieldTime = Date.now();

    // The first time around regress the lastYieldTime into the past so that
    // we don't wait around too long for the first slide (we do want to wait a
    // bit, for the user to see the checkmark animation as reassurance).
    lastYieldTime -= slideDuration - 2500; /* wait at most 2.5 s */

    /**
     * Number of time we have caught an exception while trying to generate an
     * image URL for individual files.
     *
     * When this happens three times consecutively, we throw.
     */
    let consecutiveFailures = 0;

    while (true) {
        const encryptedFiles = shuffled(
            await getEncryptedCollectionFiles(castToken),
        );

        let haveEligibleFiles = false;

        for (const encryptedFile of encryptedFiles) {
            const file = await decryptEnteFile(encryptedFile, collectionKey);

            if (!isFileEligible(file)) continue;

            console.log("will start createRenderableURL", new Date(), file);
            let url: string;
            try {
                url = await createRenderableURL(castToken, file);
                consecutiveFailures = 0;
                haveEligibleFiles = true;
            } catch (e) {
                consecutiveFailures += 1;
                // 1, 2, bang!
                if (consecutiveFailures == 3) throw e;

                if (e instanceof ApiError && e.httpStatusCode == 401) {
                    // The token has expired. This can happen, e.g., if the user
                    // opens the dialog to cast again, causing the client to
                    // invalidate existing tokens.
                    //
                    //  Rethrow the error, which will bring us back to the
                    // pairing page.
                    throw e;
                }

                // On all other errors (including temporary network issues),
                log.error("Skipping unrenderable file", e);
                continue;
            }

            console.log("did end createRenderableURL", new Date());

            // The last element of previousURLs is the URL that is currently
            // being shown on screen.
            //
            // The last to last element is the one that was shown prior to that,
            // and now can be safely revoked.
            if (previousURLs.length > 1)
                URL.revokeObjectURL(previousURLs.shift());

            previousURLs.push(url);

            const elapsedTime = Date.now() - lastYieldTime;
            if (elapsedTime > 0 && elapsedTime < slideDuration) {
                console.log("waiting", slideDuration - elapsedTime);
                await wait(slideDuration - elapsedTime);
            }

            lastYieldTime = Date.now();
            yield url;
        }

        // This collection does not have any files that we can show.
        if (!haveEligibleFiles) return;
    }
};

/**
 * Fetch the list of non-deleted files in the given collection.
 *
 * The returned files are not decrypted yet, so their metadata will not be
 * readable.
 */
const getEncryptedCollectionFiles = async (
    castToken: string,
): Promise<EncryptedEnteFile[]> => {
    let files: EncryptedEnteFile[] = [];
    let sinceTime = 0;
    let resp: AxiosResponse;
    do {
        resp = await HTTPService.get(
            `${getEndpoint()}/cast/diff`,
            { sinceTime },
            {
                "Cache-Control": "no-cache",
                "X-Cast-Access-Token": castToken,
            },
        );
        const diff = resp.data.diff;
        files = files.concat(diff.filter((file: EnteFile) => !file.isDeleted));
        sinceTime = diff.reduce(
            (max: number, file: EnteFile) => Math.max(max, file.updationTime),
            sinceTime,
        );
    } while (resp.data.hasMore);
    return files;
};

/**
 * Decrypt the given {@link EncryptedEnteFile}, returning a {@link EnteFile}.
 */
const decryptEnteFile = async (
    encryptedFile: EncryptedEnteFile,
    collectionKey: string,
): Promise<EnteFile> => {
    const worker = await ComlinkCryptoWorker.getInstance();
    const {
        encryptedKey,
        keyDecryptionNonce,
        metadata,
        magicMetadata,
        pubMagicMetadata,
        ...restFileProps
    } = encryptedFile;
    const fileKey = await worker.decryptB64(
        encryptedKey,
        keyDecryptionNonce,
        collectionKey,
    );
    const fileMetadata = await worker.decryptMetadata(
        metadata.encryptedData,
        metadata.decryptionHeader,
        fileKey,
    );
    let fileMagicMetadata: FileMagicMetadata;
    let filePubMagicMetadata: FilePublicMagicMetadata;
    if (magicMetadata?.data) {
        fileMagicMetadata = {
            ...encryptedFile.magicMetadata,
            data: await worker.decryptMetadata(
                magicMetadata.data,
                magicMetadata.header,
                fileKey,
            ),
        };
    }
    if (pubMagicMetadata?.data) {
        filePubMagicMetadata = {
            ...pubMagicMetadata,
            data: await worker.decryptMetadata(
                pubMagicMetadata.data,
                pubMagicMetadata.header,
                fileKey,
            ),
        };
    }
    const file = {
        ...restFileProps,
        key: fileKey,
        metadata: fileMetadata,
        magicMetadata: fileMagicMetadata,
        pubMagicMetadata: filePubMagicMetadata,
    };
    if (file.pubMagicMetadata?.data.editedTime) {
        file.metadata.creationTime = file.pubMagicMetadata.data.editedTime;
    }
    if (file.pubMagicMetadata?.data.editedName) {
        file.metadata.title = file.pubMagicMetadata.data.editedName;
    }
    return file;
};

const isFileEligible = (file: EnteFile) => {
    if (!isImageOrLivePhoto(file)) return false;
    if (file.info.fileSize > 100 * 1024 * 1024) return false;

    // This check is fast but potentially incorrect because in practice we do
    // encounter files that are incorrectly named and have a misleading
    // extension. To detect the actual type, we need to sniff the MIME type, but
    // that requires downloading and decrypting the file first.
    const [, extension] = nameAndExtension(file.metadata.title);
    if (isNonWebImageFileExtension(extension)) {
        // Of the known non-web types, we support HEIC.
        return isHEICExtension(extension);
    }

    return true;
};

const isImageOrLivePhoto = (file: EnteFile) => {
    const fileType = file.metadata.fileType;
    return fileType == FILE_TYPE.IMAGE || fileType == FILE_TYPE.LIVE_PHOTO;
};

export const heicToJPEG = async (heicBlob: Blob) => {
    let worker = heicWorker;
    if (!worker) heicWorker = worker = createHEICConvertComlinkWorker();
    return await (await worker.remote).heicToJPEG(heicBlob);
};

/**
 * Create and return a new data URL that can be used to show the given
 * {@link file} in our slideshow image viewer.
 *
 * Once we're done showing the file, the URL should be revoked using
 * {@link URL.revokeObjectURL} to free up browser resources.
 */
const createRenderableURL = async (castToken: string, file: EnteFile) => {
    const imageBlob = await renderableImageBlob(castToken, file);
    const resizedBlob = needsResize(file) ? await resize(imageBlob) : imageBlob;
    return URL.createObjectURL(resizedBlob);
};

const renderableImageBlob = async (castToken: string, file: EnteFile) => {
    let fileName = file.metadata.title;

    // Chromecast devices (at least the 2nd gen one) is not powerful enough to
    // do the WASM HEIC conversion, so for such files use their thumbnails
    // instead. Nb: the check is using the filename and might not be accurate.
    const [, ext] = nameAndExtension(fileName);
    const shouldUseThumbnail = isChromecast() && isHEICExtension(ext);

    let blob = await downloadFile(castToken, file, shouldUseThumbnail);

    if (!shouldUseThumbnail && file.metadata.fileType == FILE_TYPE.LIVE_PHOTO) {
        const { imageData, imageFileName } = await decodeLivePhoto(
            fileName,
            blob,
        );
        fileName = imageFileName;
        blob = new Blob([imageData]);
    }

    // We cannot rely on the file's extension to detect the file type, some
    // files are incorrectly named. So use a MIME type sniffer first, but if
    // that fails than fallback to the extension.
    const mimeType = await detectMediaMIMEType(new File([blob], fileName));
    if (!mimeType)
        throw new Error(`Could not detect MIME type for file ${fileName}`);

    if (mimeType == "image/heif" || mimeType == "image/heic")
        blob = await heicToJPEG(blob);

    return new Blob([blob], { type: mimeType });
};

const downloadFile = async (
    castToken: string,
    file: EnteFile,
    shouldUseThumbnail: boolean,
) => {
    if (!isImageOrLivePhoto(file))
        throw new Error("Can only cast images and live photos");

    const url = shouldUseThumbnail
        ? getCastThumbnailURL(file.id)
        : getCastFileURL(file.id);
    const resp = await HTTPService.get(
        url,
        null,
        {
            "X-Cast-Access-Token": castToken,
        },
        { responseType: "arraybuffer" },
    );
    if (resp.data === undefined) throw new Error(`Failed to get ${url}`);

    const cryptoWorker = await ComlinkCryptoWorker.getInstance();
    const decrypted = await cryptoWorker.decryptFile(
        new Uint8Array(resp.data),
        await cryptoWorker.fromB64(
            shouldUseThumbnail
                ? file.thumbnail.decryptionHeader
                : file.file.decryptionHeader,
        ),
        file.key,
    );
    return new Response(decrypted).blob();
};

/**
 * [Note: Chromecast media size limits]
 *
 * > Images have a display size limitation of 720p (1280x720). Images should be
 * > optimized to 1280x720 or less to avoid scaling down on the receiver device.
 * >
 * > https://developers.google.com/cast/docs/media
 *
 * So if the size of the image we're wanting to show is more than these limits,
 * resize it down to a JPEG whose size is clamped to these limits.
 */
const needsResize = (file: EnteFile) => {
    // Resize only when running on Chromecast devices.
    if (!isChromecast()) return false;

    const w = file.pubMagicMetadata?.data?.w;
    const h = file.pubMagicMetadata?.data?.h;
    // If we don't have the size, always resize to be on the safer side.
    if (!w || !h) return true;
    // Otherwise resize if any of the dimensions is outside the recommendation.
    return Math.max(w, h) > 1280 || Math.min(w, h) > 720;
};

const resize = async (blob: Blob): Promise<Blob> => {
    const canvas = document.createElement("canvas");
    const canvasCtx = ensure(canvas.getContext("2d"));

    return await new Promise((resolve, reject) => {
        const imageURL = URL.createObjectURL(blob);
        const image = new Image();
        image.setAttribute("src", imageURL);
        image.onload = () => {
            try {
                URL.revokeObjectURL(imageURL);
                const { width, height } = scaledImageDimensions(
                    image.width,
                    image.height,
                    1280,
                );
                console.log("resizing image", { image, width, height });
                canvas.width = width;
                canvas.height = height;
                canvasCtx.drawImage(image, 0, 0, width, height);
                canvas.toBlob(
                    (blob) => resolve(ensure(blob)),
                    "image/jpeg",
                    0.8 /* quality */,
                );
            } catch (e: unknown) {
                reject(e);
            }
        };
    });
};
