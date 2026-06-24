const express = require("express");
const sharp = require("sharp");

const { cleanText } = require("../config");
const { asyncHandler, createHttpError } = require("../utils/http");

const router = express.Router();
const rawImageParser = express.raw({
    type: function () {
        return true;
    },
    limit: "40mb"
});

const OUTPUT_FORMATS = {
    jpg: {
        mimeType: "image/jpeg",
        extension: ".jpg"
    },
    jpeg: {
        mimeType: "image/jpeg",
        extension: ".jpg"
    },
    png: {
        mimeType: "image/png",
        extension: ".png"
    },
    webp: {
        mimeType: "image/webp",
        extension: ".webp"
    },
    avif: {
        mimeType: "image/avif",
        extension: ".avif"
    },
    tiff: {
        mimeType: "image/tiff",
        extension: ".tif"
    },
    tif: {
        mimeType: "image/tiff",
        extension: ".tif"
    },
    gif: {
        mimeType: "image/gif",
        extension: ".gif"
    },
    heic: {
        mimeType: "image/heic",
        extension: ".heic"
    },
    heif: {
        mimeType: "image/heif",
        extension: ".heif"
    },
    bmp: {
        mimeType: "image/bmp",
        extension: ".bmp"
    },
    ico: {
        mimeType: "image/vnd.microsoft.icon",
        extension: ".ico"
    },
    svg: {
        mimeType: "image/svg+xml",
        extension: ".svg"
    }
};

router.post("/tools/image-convert", rawImageParser, asyncHandler(async function (req, res) {
    const inputBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!inputBuffer.length) {
        throw createHttpError(400, "Image data is missing.");
    }

    const fileName = sanitizeFileName(req.query.name || req.query.fileName || "image");
    const requestedFormat = normalizeOutputFormat(req.query.format);
    const formatConfig = OUTPUT_FORMATS[requestedFormat];
    if (!formatConfig) {
        throw createHttpError(400, "Unsupported output format.");
    }

    const quality = clampNumber(req.query.quality, 1, 100, 88);
    const background = parseBackgroundColor(req.query.background);
    const keepMetadata = String(req.query.keepMetadata || "").toLowerCase() === "1" || String(req.query.keepMetadata || "").toLowerCase() === "true";

    const source = sharp(inputBuffer, { animated: true, failOn: "none" }).rotate();
    const metadata = await source.metadata();

    let outputBuffer = null;

    try {
        outputBuffer = await convertBuffer({
            source: source,
            metadata: metadata,
            format: requestedFormat,
            quality: quality,
            background: background,
            keepMetadata: keepMetadata,
            inputBuffer: inputBuffer
        });
    } catch (error) {
        const message = cleanText(error && error.message) || "Unable to convert this image.";
        throw createHttpError(415, message);
    }

    const baseName = stripExtension(fileName) || "converted-image";
    const downloadName = `${baseName}${formatConfig.extension}`;

    res.setHeader("Content-Type", formatConfig.mimeType);
    res.setHeader("Content-Disposition", buildContentDisposition(downloadName));
    res.setHeader("X-Converted-Format", requestedFormat);
    res.setHeader("X-Source-Width", String(metadata.width || 0));
    res.setHeader("X-Source-Height", String(metadata.height || 0));
    res.send(outputBuffer);
}));

async function convertBuffer(options) {
    const format = cleanText(options.format).toLowerCase();
    const quality = clampNumber(options.quality, 1, 100, 88);
    const background = options.background || null;
    const keepMetadata = options.keepMetadata === true;
    const source = options.source;
    const metadata = options.metadata || {};
    const inputBuffer = Buffer.isBuffer(options.inputBuffer) ? options.inputBuffer : Buffer.alloc(0);
    const defaultBackground = background || { r: 255, g: 255, b: 255, alpha: 1 };

    const pipeline = keepMetadata ? source.clone() : source.clone().strip();

    if (format === "jpg" || format === "jpeg") {
        return (await pipeline.flatten({ background: defaultBackground }).jpeg({
            quality: quality,
            progressive: true
        }).toBuffer());
    }

    if (format === "png") {
        return (await pipeline.png({
            compressionLevel: mapPngCompressionLevel(quality),
            adaptiveFiltering: true
        }).toBuffer());
    }

    if (format === "webp") {
        return (await pipeline.webp({
            quality: quality,
            effort: quality >= 80 ? 4 : 2
        }).toBuffer());
    }

    if (format === "avif") {
        return (await pipeline.avif({
            quality: quality,
            effort: quality >= 80 ? 4 : 3
        }).toBuffer());
    }

    if (format === "tiff" || format === "tif") {
        return (await pipeline.tiff({
            quality: quality,
            compression: "lzw"
        }).toBuffer());
    }

    if (format === "gif") {
        return (await pipeline.gif().toBuffer());
    }

    if (format === "heic" || format === "heif") {
        return (await pipeline.heif({
            compression: "av1",
            quality: quality,
            effort: quality >= 80 ? 4 : 3
        }).toBuffer());
    }

    if (format === "bmp") {
        const flattened = await pipeline.flatten({ background: defaultBackground }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        return encodeBmpBuffer(flattened.data, flattened.info.width, flattened.info.height);
    }

    if (format === "ico") {
        const icon = await pipeline
            .resize({
                fit: "inside",
                width: 256,
                height: 256,
                withoutEnlargement: true
            })
            .png()
            .toBuffer({ resolveWithObject: true });

        return encodeIcoBuffer(icon.data, icon.info.width, icon.info.height);
    }

    if (format === "svg") {
        if (String(metadata.format || "").toLowerCase() === "svg" && inputBuffer.length) {
            return inputBuffer;
        }

        const rendered = await pipeline.png().toBuffer({ resolveWithObject: true });
        return encodeSvgBuffer(rendered.data, rendered.info.width, rendered.info.height);
    }

    throw createHttpError(400, "Unsupported output format.");
}

function encodeBmpBuffer(rawData, width, height) {
    const rowSize = width * 3;
    const rowPadding = (4 - (rowSize % 4)) % 4;
    const pixelDataSize = (rowSize + rowPadding) * height;
    const fileSize = 54 + pixelDataSize;
    const buffer = Buffer.alloc(fileSize);

    buffer.writeUInt16LE(0x4d42, 0);
    buffer.writeUInt32LE(fileSize, 2);
    buffer.writeUInt32LE(54, 10);
    buffer.writeUInt32LE(40, 14);
    buffer.writeInt32LE(width, 18);
    buffer.writeInt32LE(height, 22);
    buffer.writeUInt16LE(1, 26);
    buffer.writeUInt16LE(24, 28);
    buffer.writeUInt32LE(0, 30);
    buffer.writeUInt32LE(pixelDataSize, 34);

    let offset = 54;
    for (let y = height - 1; y >= 0; y -= 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 3;
            const red = rawData[index] || 0;
            const green = rawData[index + 1] || 0;
            const blue = rawData[index + 2] || 0;
            buffer[offset] = blue;
            buffer[offset + 1] = green;
            buffer[offset + 2] = red;
            offset += 3;
        }

        for (let padding = 0; padding < rowPadding; padding += 1) {
            buffer[offset] = 0;
            offset += 1;
        }
    }

    return buffer;
}

function encodeIcoBuffer(pngBuffer, width, height) {
    const headerSize = 6 + 16;
    const buffer = Buffer.alloc(headerSize + pngBuffer.length);

    buffer.writeUInt16LE(0, 0);
    buffer.writeUInt16LE(1, 2);
    buffer.writeUInt16LE(1, 4);
    buffer.writeUInt8(width >= 256 ? 0 : width, 6);
    buffer.writeUInt8(height >= 256 ? 0 : height, 7);
    buffer.writeUInt8(0, 8);
    buffer.writeUInt8(0, 9);
    buffer.writeUInt16LE(1, 10);
    buffer.writeUInt16LE(32, 12);
    buffer.writeUInt32LE(pngBuffer.length, 14);
    buffer.writeUInt32LE(headerSize, 18);
    pngBuffer.copy(buffer, headerSize);

    return buffer;
}

function encodeSvgBuffer(pngBuffer, width, height) {
    const base64 = Buffer.from(pngBuffer).toString("base64");
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:image/png;base64,${base64}" width="${width}" height="${height}"/></svg>`;
    return Buffer.from(svg, "utf8");
}

function normalizeOutputFormat(value) {
    const normalized = cleanText(value).toLowerCase();
    if (!normalized) {
        return "jpg";
    }

    if (normalized === "jpe" || normalized === "jfif" || normalized === "jpeg") {
        return "jpg";
    }

    if (normalized === "tif") {
        return "tiff";
    }

    return normalized;
}

function clampNumber(value, min, max, fallbackValue) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallbackValue;
    }

    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function mapPngCompressionLevel(quality) {
    const scale = 100 - clampNumber(quality, 1, 100, 88);
    return Math.max(0, Math.min(9, Math.round(scale / 11)));
}

function parseBackgroundColor(value) {
    const normalized = cleanText(value);
    if (!normalized) {
        return null;
    }

    const hexMatch = normalized.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (!hexMatch) {
        return null;
    }

    const hex = hexMatch[1];
    const fullHex = hex.length === 3
        ? hex.split("").map(function (char) {
            return `${char}${char}`;
        }).join("")
        : hex;

    return {
        r: parseInt(fullHex.slice(0, 2), 16),
        g: parseInt(fullHex.slice(2, 4), 16),
        b: parseInt(fullHex.slice(4, 6), 16),
        alpha: 1
    };
}

function stripExtension(fileName) {
    return cleanText(fileName).replace(/\.[^.]+$/, "");
}

function sanitizeFileName(fileName) {
    const cleaned = cleanText(fileName);
    if (!cleaned) {
        return "image";
    }

    const base = cleaned.split(/[\\/]/).pop() || "image";
    return base.replace(/[<>:"|?*\x00-\x1F]/g, "-");
}

function buildContentDisposition(fileName) {
    const fallbackName = sanitizeFileName(fileName).replace(/"/g, "'");
    const encodedName = encodeURIComponent(sanitizeFileName(fileName));
    return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`;
}

module.exports = router;
