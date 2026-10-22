import { test } from "node:test";
import assert from "node:assert/strict";
import {
    PHOTO_BUCKET, PHOTO_MAX_EDGE, PHOTO_MAX_BYTES, SIGNED_URL_SECONDS,
    photoPath, fitWithin, checkPhotoFile, jpegInfo, isNotFound, createTestPhotoRepository,
} from "../../src/app/data/supabase-test-photos.js";
import { ENVIRONMENTS } from "../../src/app/data/supabase-env.js";

/* ---------- a JPEG built segment by segment ---------- */
const seg = (marker, payload) => {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "latin1");
    const len = body.length + 2;
    return Buffer.concat([Buffer.from([0xff, marker, len >> 8, len & 0xff]), body]);
};
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const JFIF = seg(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
const sof0 = (w, h) => seg(0xc0, Buffer.from([8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]));
const SOS = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34])]);
const EXIF = seg(0xe1, "Exif\0\0MM\0*\0\0\0\x08GPS 12.97N 77.59E");
const jpeg = (...parts) => new Uint8Array(Buffer.concat([SOI, ...parts, SOS, EOI]));

test("photo paths and limits", () => {
    assert.equal(PHOTO_BUCKET, "profile-photos");
    assert.equal(photoPath("0a0a0a0a-0000-4000-8000-0000000000a1"), "0a0a0a0a-0000-4000-8000-0000000000a1/profile.jpg");
    assert.equal(PHOTO_MAX_EDGE, 512);
    assert.equal(PHOTO_MAX_BYTES, 1048576, "same as the bucket limit in 003_profile_photos.sql");
    assert.ok(SIGNED_URL_SECONDS > 0 && SIGNED_URL_SECONDS <= 300, "signed URLs are short-lived");
});

test("photo sync is on for test mode only", () => {
    assert.equal(ENVIRONMENTS.test.photoSync, true);
    assert.equal(ENVIRONMENTS.production.photoSync, false);
});

test("fitWithin scales the longest side to 512 px, keeps the ratio and never enlarges", () => {
    assert.deepEqual(fitWithin(4032, 3024), { width: 512, height: 384 });
    assert.deepEqual(fitWithin(3024, 4032), { width: 384, height: 512 });
    assert.deepEqual(fitWithin(1000, 1000), { width: 512, height: 512 });
    assert.deepEqual(fitWithin(300, 200), { width: 300, height: 200 });
    assert.deepEqual(fitWithin(10000, 10), { width: 512, height: 1 });
    assert.deepEqual(fitWithin(0, 0), { width: 1, height: 1 });
});

test("only JPEG, PNG and WebP up to 20 MB are accepted", () => {
    const f = (type, size) => ({ type, size });
    assert.equal(checkPhotoFile(f("image/jpeg", 1000)).ok, true);
    assert.equal(checkPhotoFile(f("image/png", 1000)).ok, true);
    assert.equal(checkPhotoFile(f("image/webp", 1000)).ok, true);
    assert.match(checkPhotoFile(f("image/heic", 1000)).reason, /HEIC/);
    assert.equal(checkPhotoFile(f("image/svg+xml", 1000)).ok, false, "no SVG (script-capable)");
    assert.equal(checkPhotoFile(f("image/gif", 1000)).ok, false);
    assert.equal(checkPhotoFile(f("", 1000)).ok, false);
    assert.equal(checkPhotoFile(f("image/jpeg", 0)).ok, false);
    assert.match(checkPhotoFile(f("image/jpeg", 20 * 1048576 + 1)).reason, /20 MB/);
    assert.equal(checkPhotoFile(null).ok, false);
});

test("jpegInfo finds EXIF and other metadata, and the image size", () => {
    const withExif = jpegInfo(jpeg(JFIF, EXIF, sof0(640, 480)));
    assert.equal(withExif.isJpeg, true);
    assert.equal(withExif.hasExif, true);
    assert.equal(withExif.hasMetadata, true);
    assert.deepEqual([withExif.width, withExif.height], [640, 480]);
    assert.deepEqual(withExif.segments, ["APP0", "APP1", "0xc0"]);

    const clean = jpegInfo(jpeg(JFIF, sof0(512, 384)));
    assert.equal(clean.hasExif, false);
    assert.equal(clean.hasMetadata, false, "a JFIF header is not metadata");
    assert.deepEqual([clean.width, clean.height], [512, 384]);

    assert.equal(jpegInfo(jpeg(JFIF, seg(0xe2, "ICC_PROFILE\0\x01\x01"), sof0(1, 1))).hasMetadata, false, "a colour profile is not metadata");
    assert.equal(jpegInfo(jpeg(JFIF, seg(0xee, "Adobe\0"), sof0(1, 1))).hasMetadata, false);
    assert.equal(jpegInfo(jpeg(JFIF, seg(0xe2, "MPF\0"), sof0(1, 1))).hasMetadata, true);
    assert.equal(jpegInfo(jpeg(JFIF, seg(0xe1, "http://ns.adobe.com/xap/1.0/\0<x/>"), sof0(1, 1))).hasMetadata, true, "XMP");
    assert.equal(jpegInfo(jpeg(JFIF, seg(0xed, "Photoshop 3.0\0"), sof0(1, 1))).hasMetadata, true, "IPTC");
    assert.equal(jpegInfo(jpeg(JFIF, seg(0xfe, "a comment"), sof0(1, 1))).hasMetadata, true, "COM");
    // metadata after the frame header is found too (but not inside the image data)
    assert.equal(jpegInfo(jpeg(JFIF, sof0(2, 2), EXIF)).hasExif, true);
});

test("jpegInfo rejects what isn't a well-formed JPEG", () => {
    assert.equal(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).isJpeg, false);
    assert.equal(jpegInfo(new Uint8Array([])).isJpeg, false);
    const truncated = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x40, 0x00]), Buffer.from("Exif")]);
    assert.equal(jpegInfo(new Uint8Array(truncated)).isJpeg, false);
    assert.equal(jpegInfo(new Uint8Array(Buffer.concat([SOI, Buffer.from([0x00, 0x00, 0x00, 0x00])]))).isJpeg, false);
});

test("isNotFound recognises Storage's missing-object answers only", () => {
    assert.equal(isNotFound({ statusCode: "404", message: "Object not found" }), true);
    assert.equal(isNotFound({ status: 404 }), true);
    assert.equal(isNotFound({ message: "Bucket not found" }), true);
    assert.equal(isNotFound({ statusCode: "403", message: "new row violates row-level security policy" }), false);
    assert.equal(isNotFound(null), false);
});

/* ---------- the repository with a stand-in supabase-js client ---------- */
function stubClient(answers = {}) {
    const calls = [];
    const bucketApi = (bucket) => ({
        upload: (path, body, opts) => { calls.push({ op: "upload", bucket, path, body, opts }); return Promise.resolve(answers.upload || { data: { path }, error: null }); },
        createSignedUrl: (path, seconds) => { calls.push({ op: "sign", bucket, path, seconds }); return Promise.resolve(answers.sign || { data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=t` }, error: null }); },
        remove: (paths) => { calls.push({ op: "remove", bucket, paths }); return Promise.resolve(answers.remove || { data: [], error: null }); },
    });
    return { client: { storage: { from: bucketApi } }, calls };
}

test("upload: the user's own path, JPEG, replacing the previous photo, no caching", async () => {
    const { client, calls } = stubClient();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await createTestPhotoRepository(client).upload("u-1", bytes);
    assert.deepEqual(calls, [{
        op: "upload", bucket: "profile-photos", path: "u-1/profile.jpg", body: bytes,
        opts: { upsert: true, contentType: "image/jpeg", cacheControl: "0" },
    }]);
    const failing = stubClient({ upload: { data: null, error: { statusCode: "403", message: "row-level security" } } });
    await assert.rejects(createTestPhotoRepository(failing.client).upload("u-1", bytes), { message: /row-level security/ });
});

test("load: a short-lived signed URL fetched once without caching into an in-memory blob URL", async (t) => {
    const fetches = [];
    t.mock.method(globalThis, "fetch", async (url, opts) => {
        fetches.push({ url, opts });
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    t.mock.method(URL, "createObjectURL", (blob) => `blob:fake/${blob.size}/${blob.type}`);
    const { client, calls } = stubClient();
    const url = await createTestPhotoRepository(client).load("u-1");
    assert.equal(url, "blob:fake/4/image/jpeg");
    assert.deepEqual(calls, [{ op: "sign", bucket: "profile-photos", path: "u-1/profile.jpg", seconds: SIGNED_URL_SECONDS }]);
    assert.equal(fetches.length, 1);
    assert.deepEqual(fetches[0].opts, { cache: "no-store", credentials: "omit" });

    // no photo: null, and nothing is fetched
    const none = stubClient({ sign: { data: null, error: { statusCode: "404", message: "Object not found" } } });
    assert.equal(await createTestPhotoRepository(none.client).load("u-1"), null);
    assert.equal(fetches.length, 1);
    // any other error is reported
    const denied = stubClient({ sign: { data: null, error: { statusCode: "403", message: "denied" } } });
    await assert.rejects(createTestPhotoRepository(denied.client).load("u-1"), { message: /denied/ });
});

test("load: a failed or oversized download is an error, not a photo", async (t) => {
    const { client } = stubClient();
    t.mock.method(globalThis, "fetch", async () => new Response("", { status: 400 }));
    await assert.rejects(createTestPhotoRepository(client).load("u-1"), /download failed/);
    t.mock.restoreAll();
    t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(PHOTO_MAX_BYTES + 1), { status: 200, headers: { "content-type": "image/jpeg" } }));
    await assert.rejects(createTestPhotoRepository(client).load("u-1"), /too large/);
});

test("remove: only the user's own photo path", async () => {
    const { client, calls } = stubClient();
    await createTestPhotoRepository(client).remove("u-1");
    assert.deepEqual(calls, [{ op: "remove", bucket: "profile-photos", paths: ["u-1/profile.jpg"] }]);
});
