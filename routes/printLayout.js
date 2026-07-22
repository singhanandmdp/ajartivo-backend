const express = require("express");

const { cleanText, config } = require("../config");
const { parseMultipartRequest } = require("../utils/multipart");
const { asyncHandler, createHttpError } = require("../utils/http");
const {
    buildSimpleJpegPdf,
    createBusinessCardPreviewBuffer,
    createBusinessCardSheetBuffer,
    getSheetDimensions,
    normalizePrintLayoutSettings
} = require("../utils/printLayout");

const router = express.Router();

const rawUploadParser = express.raw({
    type: function () {
        return true;
    },
    limit: config.uploads.maxFileSizeBytes
});

router.post("/tools/aj-print-layout-pro/preview", rawUploadParser, asyncHandler(async function (req, res) {
    const multipart = parseMultipartRequest(req);
    const file = multipart.files && multipart.files.file;
    if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
        throw createHttpError(400, "File data is missing.");
    }

    if (!isSupportedPreviewFile(file.fileName || "")) {
        throw createHttpError(400, "Preview supports JPG, PNG, WEBP, AVIF, GIF, BMP, HEIC, HEIF, TIF, and TIFF files.");
    }

    const previewBuffer = await createBusinessCardPreviewBuffer(file.buffer);
    res.set("Content-Type", "image/jpeg");
    res.set("Content-Disposition", `inline; filename="${cleanFileName(file.fileName || "preview.jpg")}"`);
    res.set("Cache-Control", "no-store");
    res.send(previewBuffer);
}));

router.post("/tools/aj-print-layout-pro/export", rawUploadParser, asyncHandler(async function (req, res) {
    const multipart = parseMultipartRequest(req);
    const settings = normalizePrintLayoutSettings(parseSettings(multipart.fields && multipart.fields.settings));
    const format = cleanText(multipart.fields && multipart.fields.format).toLowerCase() === "jpg" ? "jpg" : "pdf";
    const activeSide = cleanText(multipart.fields && multipart.fields.activeSide).toLowerCase() === "back" ? "back" : "front";
    const sheetDimensions = getSheetDimensions(settings);
    const renderedPages = getRenderedPreviewPages(multipart.files);

    if (renderedPages.length) {
        if (format === "jpg") {
            const primaryPage = activeSide === "back"
                ? (renderedPages.find(function (page) {
                    return page.side === "back";
                }) || renderedPages[0])
                : (renderedPages.find(function (page) {
                    return page.side === "front";
                }) || renderedPages[0]);

            res.set("Content-Type", "image/jpeg");
            res.set("Content-Disposition", `attachment; filename="${buildExportFileName(settings, primaryPage.side, "jpg")}"`);
            res.set("Cache-Control", "no-store");
            res.send(primaryPage.buffer);
            return;
        }

        const pageBuffers = [];
        for (let i = 0; i < renderedPages.length; i += 1) {
            pageBuffers.push(await toJpegPage(renderedPages[i].buffer));
        }

        const pdfBuffer = buildSimpleJpegPdf(pageBuffers, sheetDimensions);
        const fileName = buildExportFileName(settings, "pdf");

        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition", `attachment; filename="${fileName}"`);
        res.set("Cache-Control", "no-store");
        res.send(pdfBuffer);
        return;
    }

    const frontFile = multipart.files && (multipart.files.frontFile || multipart.files.front);
    const backFile = multipart.files && (multipart.files.backFile || multipart.files.back);
    const frontBuffer = getRenderableFileBuffer(frontFile);
    const backBuffer = getRenderableFileBuffer(backFile);

    if (settings.toolId !== "business-card") {
        throw createHttpError(400, "Backend export currently supports Business Card mode only.");
    }

    if (!frontBuffer && !backBuffer) {
        throw createHttpError(400, "At least one rendered file is required.");
    }

    const pageBuffers = [];

    if (format === "jpg") {
        const sourceBuffer = activeSide === "back"
            ? (backBuffer || frontBuffer)
            : (frontBuffer || backBuffer);
        const sheetBuffer = await createBusinessCardSheetBuffer(sourceBuffer, settings, sheetDimensions);
        const fileName = buildExportFileName(settings, activeSide, "jpg");

        res.set("Content-Type", "image/jpeg");
        res.set("Content-Disposition", `attachment; filename="${fileName}"`);
        res.set("Cache-Control", "no-store");
        res.send(sheetBuffer);
        return;
    }

    const frontSheetBuffer = await createBusinessCardSheetBuffer(frontBuffer || backBuffer, settings, sheetDimensions);
    pageBuffers.push(await toJpegPage(frontSheetBuffer));

    const backSheetBuffer = await createBusinessCardSheetBuffer(backBuffer || frontBuffer, settings, sheetDimensions);
    pageBuffers.push(await toJpegPage(backSheetBuffer));

    const pdfBuffer = buildSimpleJpegPdf(pageBuffers, sheetDimensions);
    const fileName = buildExportFileName(settings, "pdf");

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="${fileName}"`);
    res.set("Cache-Control", "no-store");
    res.send(pdfBuffer);
}));

async function toJpegPage(buffer) {
    const sharp = require("sharp");
    const metadata = await sharp(buffer).metadata();
    return {
        jpegBuffer: buffer,
        imageWidth: Number(metadata.width) || 1,
        imageHeight: Number(metadata.height) || 1
    };
}

function parseSettings(rawSettings) {
    const text = cleanText(rawSettings);
    if (!text) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch (_error) {
        throw createHttpError(400, "Print layout settings payload is invalid.");
    }
}

function getRenderableFileBuffer(file) {
    if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
        return null;
    }
    return file.buffer;
}

function getRenderedPreviewPages(files) {
    const frontFile = files && (files.renderedFront || files.frontPreview || files.frontSheet || files.frontImage || files.frontFile || files.front || files.file);
    const backFile = files && (files.renderedBack || files.backPreview || files.backSheet || files.backImage || files.backFile || files.back);
    const pages = [];
    const frontBuffer = getRenderableFileBuffer(frontFile);
    const backBuffer = getRenderableFileBuffer(backFile);

    if (frontBuffer) {
        pages.push({ side: "front", buffer: frontBuffer });
    }

    if (backBuffer) {
        pages.push({ side: "back", buffer: backBuffer });
    }

    return pages;
}

function isSupportedPreviewFile(fileName) {
    const lower = cleanText(fileName).toLowerCase();
    return /\.(png|jpe?g|webp|avif|gif|bmp|heic|heif|tiff?|tif)$/i.test(lower);
}

function cleanFileName(fileName) {
    const name = cleanText(fileName).replace(/["\\/<>:*?|]+/g, "-").trim();
    return name || "preview.jpg";
}

function buildExportFileName(settings, formatOrSide, maybeFormat) {
    const format = maybeFormat || formatOrSide;
    const side = maybeFormat ? formatOrSide : "";
    const baseName = `aj-print-layout-pro-${cleanText(settings.sheetSize || "12x18").toLowerCase()}`;

    if (format === "pdf") {
        return `${baseName}.pdf`;
    }

    const suffix = side === "back" ? "-back" : "-front";
    return `${baseName}${suffix}.jpg`;
}

module.exports = router;
