const path = require("path");
const { randomUUID } = require("crypto");

const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");

const { cleanText, config } = require("../config");

const designExtensions = new Set([".png", ".jpg", ".jpeg", ".zip", ".psd", ".ai", ".cdr"]);
const previewExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

let r2Client = null;

function getR2Client() {
    if (r2Client) {
        return r2Client;
    }

    r2Client = new S3Client({
        region: "auto",
        endpoint: config.r2.endpoint,
        credentials: {
            accessKeyId: config.r2.accessKey,
            secretAccessKey: config.r2.secretKey
        }
    });

    return r2Client;
}

async function uploadBufferToR2(options) {
    const uploadKind = cleanUploadKind(options && options.uploadKind);
    const fileName = cleanFileName(options && options.fileName);
    const contentType = cleanContentType(options && options.contentType, fileName, uploadKind);
    const buffer = Buffer.isBuffer(options && options.buffer) ? options.buffer : Buffer.alloc(0);
    const category = inferCategory(fileName);
    const key = buildStorageKey(uploadKind, fileName);

    await getR2Client().send(new PutObjectCommand({
        Bucket: config.r2.bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ContentDisposition: uploadKind === "design"
            ? `attachment; filename="${fileName.replace(/"/g, "")}"`
            : "inline",
        CacheControl: uploadKind === "preview"
            ? "public, max-age=31536000, immutable"
            : "public, max-age=604800"
    }));

    return {
        key: key,
        fileName: fileName,
        contentType: contentType,
        category: category,
        publicUrl: buildPublicUrl(key)
    };
}

function inferCategory(fileName) {
    const extension = path.extname(cleanFileName(fileName)).toLowerCase().replace(/^\./, "");
    return extension ? extension.toUpperCase() : "FILE";
}

function isAllowedUploadExtension(fileName, uploadKind) {
    const extension = path.extname(cleanFileName(fileName)).toLowerCase();
    const allowedExtensions = uploadKind === "preview" ? previewExtensions : designExtensions;
    return allowedExtensions.has(extension);
}

function cleanUploadKind(value) {
    return cleanText(value).toLowerCase() === "preview" ? "preview" : "design";
}

function cleanFileName(value) {
    const normalized = path.basename(cleanText(value) || `upload-${Date.now()}`);
    return normalized.replace(/[^\w.\- ]+/g, "-").slice(0, 120) || `upload-${Date.now()}`;
}

function cleanContentType(value, fileName, uploadKind) {
    const normalized = cleanText(value).toLowerCase();
    if (normalized) {
        return normalized;
    }

    const extension = path.extname(cleanFileName(fileName)).toLowerCase();
    const defaultTypes = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".zip": "application/zip",
        ".psd": "image/vnd.adobe.photoshop",
        ".ai": "application/postscript",
        ".cdr": "application/octet-stream"
    };

    return defaultTypes[extension] || (uploadKind === "preview" ? "image/png" : "application/octet-stream");
}

function buildStorageKey(uploadKind, fileName) {
    const extension = path.extname(cleanFileName(fileName)).toLowerCase();
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return [
        uploadKind === "preview" ? "preview" : "designs",
        year,
        month,
        `${Date.now()}-${randomUUID()}${extension}`
    ].join("/");
}

function buildPublicUrl(key) {
    return `${config.r2.publicUrl.replace(/\/+$/, "")}/${String(key || "").replace(/^\/+/, "")}`;
}

module.exports = {
    inferCategory,
    isAllowedUploadExtension,
    uploadBufferToR2
};
