/* =========================================================
   SUPABASE TEST MODE — profile photo (swimtics-test only)
   The photo on the Profile overview card, kept per account in the private
   `profile-photos` bucket (supabase/sql/003_profile_photos.sql) at
   `<user id>/profile.jpg`. Before upload the chosen picture is resized to
   at most PHOTO_MAX_EDGE px and re-encoded as JPEG through a canvas, which
   keeps only the pixels: EXIF (GPS location, camera, time) and every other
   metadata block is dropped, and the result is checked for that before it
   is sent. It is shown through a short-lived signed URL fetched without
   caching into an in-memory blob: URL, so nothing of it is written to this
   device's storage or HTTP cache, and it is gone after logout (which
   reloads the page). Production photos are off (D15).
   The pure helpers are tested in Node; processPhoto() needs a browser.
   Used only by supabase-accounts-core.js when env.photoSync is true.
   ========================================================= */

export const PHOTO_BUCKET = "profile-photos";
export const PHOTO_MAX_EDGE = 512;               // px, longest side
export const PHOTO_MAX_BYTES = 1048576;          // the bucket's limit (1 MiB)
export const PHOTO_SOURCE_MAX_BYTES = 20 * 1048576;
export const PHOTO_SOURCE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
export const SIGNED_URL_SECONDS = 60;            // only long enough to fetch it once

export function photoPath(uid) {
    return `${uid}/profile.jpg`;
}

/* The largest width x height within maxEdge, keeping the aspect ratio,
   never enlarging. */
export function fitWithin(width, height, maxEdge = PHOTO_MAX_EDGE) {
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/* Whether a chosen file can be turned into a profile photo. */
export function checkPhotoFile(file) {
    if (!file) return { ok: false, reason: "No photo was chosen." };
    const type = String(file.type || "").toLowerCase();
    if (!PHOTO_SOURCE_TYPES.includes(type)) {
        return { ok: false, reason: "Please choose a JPEG, PNG or WebP photo. (HEIC photos from some phones can't be read by the browser — save it as JPEG first.)" };
    }
    if (!(file.size > 0)) return { ok: false, reason: "That file is empty." };
    if (file.size > PHOTO_SOURCE_MAX_BYTES) return { ok: false, reason: "That photo is larger than 20 MB. Please choose a smaller one." };
    return { ok: true };
}

/* JPEG structure: dimensions and the metadata segments it carries. Walks
   the markers up to the start of the image data. Metadata = any APPn
   segment except APP0 (JFIF), APP2 holding an ICC colour profile, and
   APP14 (Adobe colour transform), plus comments (COM). */
export function jpegInfo(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const out = { isJpeg: false, width: 0, height: 0, segments: [], hasExif: false, hasMetadata: false };
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return out;
    out.isJpeg = true;
    const ascii = (start, len) => String.fromCharCode(...b.subarray(start, Math.min(b.length, start + len)));
    let i = 2;
    while (i + 4 <= b.length) {
        if (b[i] !== 0xff) { out.isJpeg = false; break; }
        const marker = b[i + 1];
        if (marker === 0xff) { i += 1; continue; }                     // fill byte
        if (marker === 0xd9 || marker === 0xda) break;                  // end / start of scan
        if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; }     // restart markers carry no length
        const len = (b[i + 2] << 8) | b[i + 3];
        if (len < 2 || i + 2 + len > b.length) { out.isJpeg = false; break; }
        const body = i + 4;
        let name = `0x${marker.toString(16)}`;
        if (marker >= 0xe0 && marker <= 0xef) {
            name = `APP${marker - 0xe0}`;
            const id = ascii(body, 12);
            const harmless = marker === 0xe0 || marker === 0xee || (marker === 0xe2 && id.startsWith("ICC_PROFILE"));
            if (marker === 0xe1 && id.startsWith("Exif\0")) out.hasExif = true;
            if (!harmless) out.hasMetadata = true;
        } else if (marker === 0xfe) {
            name = "COM";
            out.hasMetadata = true;
        } else if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            out.height = (b[body + 1] << 8) | b[body + 2];
            out.width = (b[body + 3] << 8) | b[body + 4];
        }
        out.segments.push(name);
        i += 2 + len;
    }
    return out;
}

/* A Storage error meaning "there is no such object" (the API answers 400
   with statusCode "404"). */
export function isNotFound(error) {
    if (!error) return false;
    return String(error.statusCode) === "404" || error.status === 404 || /not.?found/i.test(String(error.message || ""));
}

/* ---------- browser only: resize + re-encode ---------- */

async function decode(file) {
    if (typeof createImageBitmap === "function") {
        try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fall back */ }
    }
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
    } finally { URL.revokeObjectURL(url); }
}

/* file -> { bytes: Uint8Array (JPEG, no metadata), width, height }.
   Throws an Error with a user-facing message if it can't. */
export async function processPhoto(file) {
    const check = checkPhotoFile(file);
    if (!check.ok) throw new Error(check.reason);
    let image;
    try { image = await decode(file); } catch { throw new Error("That photo couldn't be read. Please choose another one."); }
    const { width, height } = fitWithin(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";                            // transparent PNG areas become white, not black
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);
    if (typeof image.close === "function") image.close();
    for (const quality of [0.85, 0.75, 0.65, 0.5]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob) break;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const info = jpegInfo(bytes);
        if (!info.isJpeg || info.hasMetadata) throw new Error("This browser couldn't remove the photo's metadata, so it wasn't uploaded.");
        if (bytes.length <= PHOTO_MAX_BYTES) return { bytes, width, height };
    }
    throw new Error("That photo couldn't be made small enough. Please choose another one.");
}

/* ---------- repository: a supabase-js client is passed in ---------- */

export function createTestPhotoRepository(client) {
    const bucket = () => client.storage.from(PHOTO_BUCKET);

    async function upload(uid, bytes) {
        const { error } = await bucket().upload(photoPath(uid), bytes, {
            upsert: true, contentType: "image/jpeg", cacheControl: "0",
        });
        if (error) throw error;
    }

    /* A blob: URL of the user's photo, or null if they have none. The
       signed URL is fetched once, uncached, and never stored. */
    async function load(uid) {
        const { data, error } = await bucket().createSignedUrl(photoPath(uid), SIGNED_URL_SECONDS);
        if (error) {
            if (isNotFound(error)) return null;
            throw error;
        }
        const res = await fetch(data.signedUrl, { cache: "no-store", credentials: "omit" });
        if (!res.ok) throw new Error(`photo download failed (${res.status})`);
        const blob = await res.blob();
        if (blob.size > PHOTO_MAX_BYTES) throw new Error("photo too large");
        return URL.createObjectURL(blob.type === "image/jpeg" ? blob : new Blob([blob], { type: "image/jpeg" }));
    }

    async function remove(uid) {
        const { error } = await bucket().remove([photoPath(uid)]);
        if (error) throw error;
    }

    return { upload, load, remove };
}
