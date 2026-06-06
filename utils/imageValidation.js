const SUPPORTED_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif"
]);

function cleanMimeType(value) {
    return String(value || "").trim().toLowerCase();
}

function isSupportedImageMimeType(value) {
    return SUPPORTED_IMAGE_MIME_TYPES.has(cleanMimeType(value));
}

function detectImageMimeTypeFromBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
        return "";
    }

    if (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return "image/png";
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return "image/jpeg";
    }

    if (
        buffer.slice(0, 4).toString("ascii") === "GIF8" &&
        (buffer.slice(0, 6).toString("ascii") === "GIF87a" || buffer.slice(0, 6).toString("ascii") === "GIF89a")
    ) {
        return "image/gif";
    }

    if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
        return "image/webp";
    }

    const boxType = buffer.slice(4, 12).toString("ascii");
    if (boxType.includes("ftypavif") || boxType.includes("ftypavis")) {
        return "image/avif";
    }

    return "";
}

function isSupportedImageBuffer(buffer) {
    return Boolean(detectImageMimeTypeFromBuffer(buffer));
}

function validateImageUpload(file) {
    const buffer = Buffer.isBuffer(file && file.buffer) ? file.buffer : Buffer.alloc(0);
    const mimeType = cleanMimeType(file && file.mimetype);

    if (!buffer.length) {
        return {
            ok: false,
            status: 400,
            message: "Image file is missing."
        };
    }

    if (!isSupportedImageMimeType(mimeType)) {
        return {
            ok: false,
            status: 415,
            message: "Only JPEG, PNG, WebP, GIF, and AVIF images are allowed."
        };
    }

    if (!isSupportedImageBuffer(buffer)) {
        return {
            ok: false,
            status: 415,
            message: "Uploaded file does not look like a valid image."
        };
    }

    return {
        ok: true,
        buffer: buffer,
        mimeType: mimeType || detectImageMimeTypeFromBuffer(buffer)
    };
}

module.exports = {
    detectImageMimeTypeFromBuffer,
    isSupportedImageBuffer,
    isSupportedImageMimeType,
    validateImageUpload
};
