const fs = require("fs/promises");
const path = require("path");

const { config, cleanText } = require("../config");
const { createHttpError } = require("../utils/http");

let gradioModulePromise = null;
let gradioClientPromise = null;

function isHttpUrl(value) {
    return /^https?:\/\//i.test(cleanText(value));
}

function getGradioModule() {
    if (!gradioModulePromise) {
        gradioModulePromise = import("@gradio/client");
    }

    return gradioModulePromise;
}

async function getGradioClient() {
    if (!gradioClientPromise) {
        gradioClientPromise = (async function () {
            const { Client } = await getGradioModule();
            const options = {};

            if (config.hfRemoveBg.token) {
                options.token = config.hfRemoveBg.token;
            }

            if (typeof Client.connect !== "function") {
                throw createHttpError(500, "Gradio client is unavailable.");
            }

            return Client.connect(config.hfRemoveBg.spaceId, options);
        })().catch(function (error) {
            gradioClientPromise = null;
            throw error;
        });
    }

    return gradioClientPromise;
}

async function removeBackgroundViaSpace(upload) {
    const client = await getGradioClient();
    const { handle_file } = await getGradioModule();

    if (typeof client.predict !== "function") {
        throw createHttpError(502, "Gradio space client is not ready.");
    }

    const prediction = await withRetry(function () {
        return client.predict(config.hfRemoveBg.apiName, {
            image: handle_file(upload.buffer)
        });
    });

    console.log("HF RESULT:");
    console.log(JSON.stringify(prediction, null, 2));

    return normalizePredictionResult(prediction);
}

async function withRetry(action, attempts) {
    const maxAttempts = Math.max(1, Number(attempts) || 2);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await action();
        } catch (error) {
            lastError = error;
            if (attempt < maxAttempts) {
                await delay(250 * attempt);
                continue;
            }
        }
    }

    throw lastError || createHttpError(502, "Hugging Face processing failed.");
}

function delay(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
}

async function normalizePredictionResult(prediction) {
    const rawData = prediction && typeof prediction === "object" && Object.prototype.hasOwnProperty.call(prediction, "data")
        ? prediction.data
        : prediction;

    const firstValue = Array.isArray(rawData) && rawData.length ? rawData[0] : rawData;

    if (typeof firstValue === "string") {
        return normalizeStringOutput(firstValue);
    }

    const fileLike = findFileLikeValue(firstValue);
    if (fileLike) {
        return normalizeFileLikeOutput(fileLike);
    }

    if (typeof rawData === "string") {
        return normalizeStringOutput(rawData);
    }

    return {
        url: "",
        dataUrl: "",
        mimeType: "image/png",
        fileName: "ajartivo.png",
        raw: rawData
    };
}

function findFileLikeValue(value, depth) {
    const currentDepth = Number(depth) || 0;
    if (currentDepth > 4 || value == null) {
        return null;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findFileLikeValue(item, currentDepth + 1);
            if (found) {
                return found;
            }
        }

        return null;
    }

    if (typeof value === "object") {
        const directUrl = cleanText(value.url);
        const directPath = cleanText(value.path);
        if (directUrl || directPath) {
            return value;
        }

        const keys = Object.keys(value);
        for (const key of keys) {
            const found = findFileLikeValue(value[key], currentDepth + 1);
            if (found) {
                return found;
            }
        }
    }

    return null;
}

async function normalizeFileLikeOutput(fileLike) {
    const url = cleanText(fileLike.url);
    const pathValue = cleanText(fileLike.path);
    const fileName = cleanText(fileLike.orig_name || fileLike.name || fileLike.file_name || fileLike.filename) || "ajartivo.png";
    const mimeType = cleanText(fileLike.mime_type || fileLike.mimeType) || inferMimeType(fileName) || inferMimeType(pathValue) || "image/png";
    const size = Number(fileLike.size);
    let dataUrl = cleanText(fileLike.dataUrl || fileLike.data_url || fileLike.data);

    if (dataUrl && !/^data:/i.test(dataUrl)) {
        dataUrl = "";
    }

    if (!dataUrl) {
        if (pathValue && !isHttpUrl(pathValue)) {
            dataUrl = await tryReadLocalFileAsDataUrl(pathValue, mimeType);
        } else if (url && isHttpUrl(url)) {
            dataUrl = await tryDownloadAsDataUrl(url, mimeType);
        }
    }

    return {
        url: url,
        dataUrl: dataUrl,
        mimeType: mimeType,
        fileName: fileName,
        size: Number.isFinite(size) ? size : 0,
        raw: fileLike
    };
}

async function normalizeStringOutput(value) {
    const cleaned = cleanText(value);
    if (!cleaned) {
        return {
            url: "",
            dataUrl: "",
            mimeType: "image/png",
            fileName: "ajartivo.png",
            raw: value
        };
    }

    if (/^data:/i.test(cleaned)) {
        return {
            url: "",
            dataUrl: cleaned,
            mimeType: inferMimeType(cleaned) || "image/png",
            fileName: "ajartivo.png",
            raw: value
        };
    }

    let dataUrl = "";
    if (isHttpUrl(cleaned)) {
        dataUrl = await tryDownloadAsDataUrl(cleaned, inferMimeType(cleaned) || "image/png");
    }

    return {
        url: cleaned,
        dataUrl: dataUrl,
        mimeType: inferMimeType(cleaned) || "image/png",
        fileName: inferFileNameFromUrl(cleaned),
        raw: value
    };
}

async function tryReadLocalFileAsDataUrl(filePath, mimeType) {
    try {
        const buffer = await fs.readFile(filePath);
        return bufferToDataUrl(buffer, mimeType);
    } catch (_error) {
        return "";
    }
}

async function tryDownloadAsDataUrl(url, mimeType) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            return "";
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        return bufferToDataUrl(buffer, mimeType);
    } catch (_error) {
        return "";
    }
}

function bufferToDataUrl(buffer, mimeType) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        return "";
    }

    return `data:${cleanText(mimeType) || "image/png"};base64,${buffer.toString("base64")}`;
}

function inferMimeType(value) {
    const cleaned = cleanText(value).toLowerCase();
    if (!cleaned) {
        return "";
    }

    if (cleaned.startsWith("data:image/png")) {
        return "image/png";
    }

    if (cleaned.startsWith("data:image/jpeg") || cleaned.startsWith("data:image/jpg")) {
        return "image/jpeg";
    }

    if (cleaned.startsWith("data:image/webp")) {
        return "image/webp";
    }

    if (cleaned.startsWith("data:image/gif")) {
        return "image/gif";
    }

    if (cleaned.startsWith("data:image/avif")) {
        return "image/avif";
    }

    if (cleaned.endsWith(".png")) {
        return "image/png";
    }

    if (cleaned.endsWith(".jpg") || cleaned.endsWith(".jpeg") || cleaned.endsWith(".jpe")) {
        return "image/jpeg";
    }

    if (cleaned.endsWith(".webp")) {
        return "image/webp";
    }

    if (cleaned.endsWith(".gif")) {
        return "image/gif";
    }

    if (cleaned.endsWith(".avif")) {
        return "image/avif";
    }

    return "";
}

function inferFileNameFromUrl(value) {
    const cleaned = cleanText(value);
    if (!cleaned) {
        return "ajartivo.png";
    }

    try {
        const parsed = new URL(cleaned);
        const name = path.basename(parsed.pathname || "");
        return name || "ajartivo.png";
    } catch (_error) {
        return path.basename(cleaned) || "ajartivo.png";
    }
}

module.exports = {
    bufferToDataUrl,
    getGradioClient,
    normalizePredictionResult,
    removeBackgroundViaSpace,
    tryDownloadAsDataUrl,
    tryReadLocalFileAsDataUrl
};
