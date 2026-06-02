const express = require("express");

const { cleanText, config } = require("../config");
const { requirePhotoRoomConfigured } = require("../middleware/requireConfig");
const { asyncHandler, createHttpError } = require("../utils/http");

const router = express.Router();
const rawUploadParser = express.raw({
    type: function () {
        return true;
    },
    limit: "40mb"
});

const PHOTOROOM_REMOVE_BG_URL = "https://sdk.photoroom.com/v1/segment";
const MULTIPART_FIELD_NAMES = new Set(["image", "file", "upload", "image_file"]);

router.post(
    ["/remove-bg", "/remove-background", "/smart-remove-bg", "/tools/remove-bg", "/tools/background-remove"],
    requirePhotoRoomConfigured,
    rawUploadParser,
    asyncHandler(async function (req, res) {
        const requestBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!requestBuffer.length) {
            throw createHttpError(400, "Image data is missing.");
        }

        const contentType = cleanText(req.headers["content-type"]);
        const upload = parseUploadFromRequest({
            buffer: requestBuffer,
            contentType: contentType,
            fileName: decodeHeaderText(req.headers["x-file-name"]),
            fileType: decodeHeaderText(req.headers["x-file-type"] || req.headers["content-type"]),
            query: req.query
        });

        if (!upload.buffer.length) {
            throw createHttpError(400, "Image data is missing.");
        }

        const response = await sendToPhotoRoom(upload);
        const responseBuffer = Buffer.from(await response.arrayBuffer());

        if (!response.ok) {
            throw createHttpError(
                response.status >= 400 && response.status < 600 ? response.status : 502,
                parsePhotoRoomError(responseBuffer, response.headers.get("content-type"))
            );
        }

        const responseType = cleanText(response.headers.get("content-type")) || "image/png";
        const responseName = buildOutputFileName(upload.fileName, responseType);

        res.status(response.status || 200);
        res.setHeader("Content-Type", responseType);
        res.setHeader("Content-Disposition", buildContentDisposition(responseName));
        res.setHeader("X-PhotoRoom-Source", "photoroom");
        res.setHeader("X-PhotoRoom-Format", cleanText(upload.format) || "png");
        res.send(responseBuffer);
    })
);

function parseUploadFromRequest(input) {
    const buffer = Buffer.isBuffer(input && input.buffer) ? input.buffer : Buffer.alloc(0);
    const contentType = cleanText(input && input.contentType);
    const fallbackName = sanitizeFileName(input && input.fileName) || "image";
    const fallbackType = cleanText(input && input.fileType) || "application/octet-stream";
    const query = input && input.query ? input.query : {};

    if (isMultipartFormData(contentType)) {
        const parsed = extractMultipartFile(buffer, contentType);
        if (!parsed) {
            throw createHttpError(400, "Uploaded image field is missing.");
        }

        return {
            buffer: parsed.buffer,
            fileName: sanitizeFileName(parsed.fileName || fallbackName),
            contentType: cleanText(parsed.contentType) || fallbackType,
            format: normalizeOutputFormat(query.format || query.outputFormat),
            size: normalizeSize(query.size),
            crop: normalizeCrop(query.crop),
            bgColor: normalizeBackgroundColor(query.bg_color || query.bgColor),
            channels: normalizeChannels(query.channels)
        };
    }

    return {
        buffer: buffer,
        fileName: fallbackName,
        contentType: fallbackType,
        format: normalizeOutputFormat(query.format || query.outputFormat),
        size: normalizeSize(query.size),
        crop: normalizeCrop(query.crop),
        bgColor: normalizeBackgroundColor(query.bg_color || query.bgColor),
        channels: normalizeChannels(query.channels)
    };
}

async function sendToPhotoRoom(upload) {
    const formData = new FormData();
    const imageBlob = new Blob([upload.buffer], {
        type: cleanText(upload.contentType) || "application/octet-stream"
    });

    formData.append("image_file", imageBlob, upload.fileName || "image.png");
    formData.append("format", upload.format || "png");
    formData.append("channels", upload.channels || "rgba");
    formData.append("size", upload.size || "full");

    if (upload.bgColor) {
        formData.append("bg_color", upload.bgColor);
    }

    if (upload.crop) {
        formData.append("crop", upload.crop);
    }

    const response = await fetch(cleanText(config.photoRoom.apiBaseUrl) || PHOTOROOM_REMOVE_BG_URL, {
        method: "POST",
        headers: {
            "x-api-key": config.photoRoom.apiKey,
            "Accept": "image/*, application/json"
        },
        body: formData
    });

    return response;
}

function isMultipartFormData(contentType) {
    return /multipart\/form-data/i.test(cleanText(contentType));
}

function extractMultipartFile(buffer, contentType) {
    const boundary = extractBoundary(contentType);
    if (!boundary) {
        return null;
    }

    const boundaryMarker = Buffer.from(`--${boundary}`);
    let searchIndex = buffer.indexOf(boundaryMarker);

    while (searchIndex !== -1) {
        const partStart = searchIndex + boundaryMarker.length;
        const headerStart = skipLineBreak(buffer, partStart);
        const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
        if (headerEnd === -1) {
            break;
        }

        const headerBlock = buffer.slice(headerStart, headerEnd).toString("utf8");
        const contentStart = headerEnd + 4;
        const nextBoundaryIndex = buffer.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
        if (nextBoundaryIndex === -1) {
            break;
        }

        const contentEnd = nextBoundaryIndex;
        const disposition = parseContentDisposition(headerBlock);
        const fieldName = cleanText(disposition.name).toLowerCase();
        const fileName = cleanText(disposition.filename);
        const contentTypeHeader = parseHeaderValue(headerBlock, "content-type");

        if (disposition.filename || MULTIPART_FIELD_NAMES.has(fieldName)) {
            return {
                buffer: buffer.slice(contentStart, contentEnd),
                fileName: fileName || "image.png",
                contentType: contentTypeHeader || "application/octet-stream"
            };
        }

        searchIndex = buffer.indexOf(boundaryMarker, nextBoundaryIndex);
    }

    return null;
}

function parseContentDisposition(headerBlock) {
    const line = parseHeaderValue(headerBlock, "content-disposition");
    const nameMatch = line.match(/name="([^"]+)"/i);
    const fileMatch = line.match(/filename="([^"]*)"/i);

    return {
        name: nameMatch ? nameMatch[1] : "",
        filename: fileMatch ? fileMatch[1] : ""
    };
}

function parseHeaderValue(headerBlock, headerName) {
    const pattern = new RegExp(`^${escapeRegExp(headerName)}:\\s*(.+)$`, "im");
    const match = headerBlock.match(pattern);
    return match ? cleanText(match[1]) : "";
}

function extractBoundary(contentType) {
    const match = cleanText(contentType).match(/boundary=([^;]+)/i);
    if (!match) {
        return "";
    }

    return match[1].replace(/^"|"$/g, "");
}

function skipLineBreak(buffer, index) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
        return index + 2;
    }

    return index;
}

function parsePhotoRoomError(buffer, contentType) {
    const text = cleanText(buffer.toString("utf8"));
    if (!text) {
        return "PhotoRoom processing failed.";
    }

    if (/json/i.test(cleanText(contentType))) {
        try {
            const payload = JSON.parse(text);
            return cleanText(payload && (payload.error || payload.message)) || "PhotoRoom processing failed.";
        } catch (_error) {
            return text;
        }
    }

    return text;
}

function normalizeOutputFormat(value) {
    const normalized = cleanText(value).toLowerCase();
    if (!normalized) {
        return "png";
    }

    if (normalized === "jpeg" || normalized === "jpe" || normalized === "jpg") {
        return "jpg";
    }

    if (normalized === "webp") {
        return "webp";
    }

    return "png";
}

function normalizeSize(value) {
    const normalized = cleanText(value).toLowerCase();
    if (["preview", "medium", "hd", "full"].includes(normalized)) {
        return normalized;
    }

    return "full";
}

function normalizeCrop(value) {
    const normalized = cleanText(value).toLowerCase();
    if (["circle", "square", "landscape", "portrait", "original"].includes(normalized)) {
        return normalized;
    }

    return "";
}

function normalizeChannels(value) {
    const normalized = cleanText(value).toLowerCase();
    if (normalized === "alpha") {
        return "alpha";
    }

    return "rgba";
}

function normalizeBackgroundColor(value) {
    const normalized = cleanText(value);
    if (!normalized) {
        return "";
    }

    return normalized.replace(/^#/, "");
}

function buildOutputFileName(fileName, contentType) {
    const baseName = stripExtension(sanitizeFileName(fileName) || "image");
    const extension = inferExtensionFromContentType(contentType);
    return `${baseName || "image"}${extension}`;
}

function inferExtensionFromContentType(contentType) {
    const normalized = cleanText(contentType).toLowerCase();
    if (normalized.includes("jpeg") || normalized.includes("jpg")) {
        return ".jpg";
    }

    if (normalized.includes("webp")) {
        return ".webp";
    }

    return ".png";
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
    const safeName = sanitizeFileName(fileName).replace(/"/g, "'");
    const encodedName = encodeURIComponent(sanitizeFileName(fileName));
    return `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`;
}

function decodeHeaderText(value) {
    const normalized = cleanText(Array.isArray(value) ? value[0] : value);
    if (!normalized) {
        return "";
    }

    try {
        return decodeURIComponent(normalized);
    } catch (_error) {
        return normalized;
    }
}

function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = router;
