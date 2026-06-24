const sharp = require("sharp");

const { cleanText, config } = require("../config");
const { createHttpError } = require("./http");

const BUSINESS_CARD_PREVIEW_MAX_SIDE_PX = 2400;
const EXPORT_DPI = 300;

function normalizePrintLayoutSettings(rawSettings) {
    const settings = rawSettings && typeof rawSettings === "object" ? rawSettings : {};

    return {
        toolId: cleanText(settings.toolId) || "business-card",
        sheetSize: cleanText(settings.sheetSize) || "12x18",
        orientation: cleanText(settings.orientation) === "portrait" ? "portrait" : "landscape",
        businessCardWidth: normalizeNumber(settings.businessCardWidth, 2.15, 1, 6),
        businessCardHeight: normalizeNumber(settings.businessCardHeight, 3.3, 1, 6),
        businessGapX: normalizeNumber(settings.businessGapX, 0.25, 0, 1),
        businessGapY: normalizeNumber(settings.businessGapY, 0.313, 0, 1),
        businessBorderMargin: normalizeNumber(settings.businessBorderMargin, 0.125, 0, 1),
        businessCardRotation: normalizeRotation(settings.businessCardRotation),
        businessFitToCard: Boolean(settings.businessFitToCard),
        businessCutMarks: settings.businessCutMarks !== false,
        previewBackgroundMode: cleanText(settings.previewBackgroundMode) === "color" ? "color" : "white",
        previewBackgroundColor: normalizeHexColor(settings.previewBackgroundColor, "#ffffff"),
        customWidth: normalizeNumber(settings.customWidth, 12, 4, 40),
        customHeight: normalizeNumber(settings.customHeight, 18, 4, 40)
    };
}

function getSheetDimensions(settings) {
    if (settings.sheetSize === "Custom") {
        const width = clamp(settings.customWidth, 4, 40);
        const height = clamp(settings.customHeight, 4, 40);
        return settings.orientation === "portrait"
            ? { width: Math.min(width, height), height: Math.max(width, height) }
            : { width: Math.max(width, height), height: Math.min(width, height) };
    }

    const preset = getSheetPreset(settings.sheetSize);
    const width = Number(preset.width || 18);
    const height = Number(preset.height || 12);
    return settings.orientation === "portrait"
        ? { width: Math.min(width, height), height: Math.max(width, height) }
        : { width: Math.max(width, height), height: Math.min(width, height) };
}

function getBusinessCardLayout(settings, dimensions) {
    const cols = 5;
    const rows = 5;
    const isLandscapeCard = Number(settings.businessCardRotation) === 90;
    const cardWIn = isLandscapeCard
        ? clamp(settings.businessCardHeight, 1, 6)
        : clamp(settings.businessCardWidth, 1, 6);
    const cardHIn = isLandscapeCard
        ? clamp(settings.businessCardWidth, 1, 6)
        : clamp(settings.businessCardHeight, 1, 6);
    const gapMinXIn = isLandscapeCard
        ? clamp(settings.businessGapY, 0, 1)
        : clamp(settings.businessGapX, 0, 1);
    const gapMinYIn = isLandscapeCard
        ? clamp(settings.businessGapX, 0, 1)
        : clamp(settings.businessGapY, 0, 1);
    const marginIn = clamp(settings.businessBorderMargin, 0, 1);
    const usableWIn = Math.max(0, dimensions.width - marginIn * 2);
    const usableHIn = Math.max(0, dimensions.height - marginIn * 2);
    const minTotalWIn = cols * cardWIn + (cols - 1) * gapMinXIn;
    const minTotalHIn = rows * cardHIn + (rows - 1) * gapMinYIn;
    const fitScale = Math.min(
        1,
        usableWIn / Math.max(minTotalWIn, 0.001),
        usableHIn / Math.max(minTotalHIn, 0.001)
    );
    const drawCardWIn = cardWIn * fitScale;
    const drawCardHIn = cardHIn * fitScale;
    const gapXIn = cols > 1 ? Math.max(0, (usableWIn - cols * drawCardWIn) / (cols - 1)) : 0;
    const gapYIn = rows > 1 ? Math.max(0, (usableHIn - rows * drawCardHIn) / (rows - 1)) : 0;

    return {
        cols: cols,
        rows: rows,
        isLandscapeCard: isLandscapeCard,
        marginIn: marginIn,
        cardWIn: drawCardWIn,
        cardHIn: drawCardHIn,
        gapXIn: gapXIn,
        gapYIn: gapYIn
    };
}

async function createBusinessCardPreviewBuffer(fileBuffer) {
    const prepared = sharp(fileBuffer, { animated: true, failOn: "none" }).rotate();
    const metadata = await prepared.metadata();
    const maxSide = Math.max(Number(metadata.width) || 0, Number(metadata.height) || 0);
    const resizeOptions = maxSide > BUSINESS_CARD_PREVIEW_MAX_SIDE_PX
        ? {
            width: BUSINESS_CARD_PREVIEW_MAX_SIDE_PX,
            height: BUSINESS_CARD_PREVIEW_MAX_SIDE_PX,
            fit: "inside",
            withoutEnlargement: true
        }
        : null;

    const base = resizeOptions ? prepared.resize(resizeOptions) : prepared;

    return base
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
}

async function createBusinessCardSheetBuffer(sourceBuffer, settings, sheetDimensions) {
    if (settings.toolId !== "business-card") {
        throw createHttpError(400, "Backend export currently supports Business Card mode only.");
    }

    const layout = getBusinessCardLayout(settings, sheetDimensions);
    const sheetWidthPx = Math.max(1, Math.round(sheetDimensions.width * EXPORT_DPI));
    const sheetHeightPx = Math.max(1, Math.round(sheetDimensions.height * EXPORT_DPI));
    const background = settings.previewBackgroundMode === "color"
        ? normalizeHexColor(settings.previewBackgroundColor, "#ffffff")
        : "#ffffff";

    const source = sharp(sourceBuffer, { animated: true, failOn: "none" }).rotate();
    const tile = await createBusinessCardTileBuffer(source, layout, EXPORT_DPI, settings.businessFitToCard);
    const composites = [];

    for (let row = 0; row < layout.rows; row += 1) {
        for (let col = 0; col < layout.cols; col += 1) {
            const left = Math.round((layout.marginIn + col * (layout.cardWIn + layout.gapXIn)) * EXPORT_DPI);
            const top = Math.round((layout.marginIn + row * (layout.cardHIn + layout.gapYIn)) * EXPORT_DPI);
            composites.push({
                input: tile,
                left: left,
                top: top
            });
        }
    }

    if (settings.businessCutMarks) {
        composites.push({
            input: Buffer.from(buildBusinessCutMarksSvg(layout, sheetDimensions, EXPORT_DPI, background)),
            left: 0,
            top: 0
        });
    }

    return sharp({
        create: {
            width: sheetWidthPx,
            height: sheetHeightPx,
            channels: 4,
            background: background
        }
    })
        .composite(composites)
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer();
}

async function createBusinessCardTileBuffer(source, layout, dpi, fitToCard) {
    const cardWidthPx = Math.max(1, Math.round(layout.cardWIn * dpi));
    const cardHeightPx = Math.max(1, Math.round(layout.cardHIn * dpi));
    const inset = Math.max(2, Math.round(Math.min(cardWidthPx, cardHeightPx) * 0.08));
    const innerWidth = Math.max(1, cardWidthPx - inset * 2);
    const innerHeight = Math.max(1, cardHeightPx - inset * 2);
    const imageBuffer = fitToCard
        ? await source.clone().resize({
            width: cardWidthPx,
            height: cardHeightPx,
            fit: "fill",
            withoutEnlargement: false
        }).flatten({ background: "#ffffff" }).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
        : await source.clone().resize({
            width: innerWidth,
            height: innerHeight,
            fit: "inside",
            withoutEnlargement: false
        }).flatten({ background: "#ffffff" }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();

    const imageMeta = await sharp(imageBuffer).metadata();
    const imageLeft = fitToCard
        ? 0
        : inset + Math.max(0, Math.round((innerWidth - Number(imageMeta.width || 0)) / 2));
    const imageTop = fitToCard
        ? 0
        : inset + Math.max(0, Math.round((innerHeight - Number(imageMeta.height || 0)) / 2));

    return sharp({
        create: {
            width: cardWidthPx,
            height: cardHeightPx,
            channels: 4,
            background: "#ffffff"
        }
    })
        .composite([
            {
                input: imageBuffer,
                left: imageLeft,
                top: imageTop
            },
            {
                input: Buffer.from(buildBusinessCardTileBorderSvg(cardWidthPx, cardHeightPx)),
                left: 0,
                top: 0
            }
        ])
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer();
}

function buildBusinessCardTileBorderSvg(widthPx, heightPx) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}">
  <rect x="0.5" y="0.5" width="${Math.max(0, widthPx - 1)}" height="${Math.max(0, heightPx - 1)}" fill="none" stroke="rgba(15, 23, 42, 0.12)" stroke-width="1" />
</svg>`;
}

function buildBusinessCutMarksSvg(layout, dimensions, dpi, background) {
    const sheetWidthPx = Math.round(dimensions.width * dpi);
    const sheetHeightPx = Math.round(dimensions.height * dpi);
    const marginPx = layout.marginIn * dpi;
    const cardW = layout.cardWIn * dpi;
    const cardH = layout.cardHIn * dpi;
    const gapX = layout.gapXIn * dpi;
    const gapY = layout.gapYIn * dpi;
    const startX = marginPx + Math.max(0, ((sheetWidthPx - marginPx * 2) - (layout.cols * cardW + (layout.cols - 1) * gapX)) / 2);
    const startY = marginPx + Math.max(0, ((sheetHeightPx - marginPx * 2) - (layout.rows * cardH + (layout.rows - 1) * gapY)) / 2);
    const size = Math.max(4, Math.min(gapX, gapY) * 0.25);
    const markColor = "rgba(15, 23, 42, 0.6)";
    const lines = [];

    for (let row = 0; row < layout.rows - 1; row += 1) {
        for (let col = 0; col < layout.cols - 1; col += 1) {
            const x = startX + cardW + (gapX / 2) + col * (cardW + gapX);
            const y = startY + cardH + (gapY / 2) + row * (cardH + gapY);
            lines.push(`<line x1="${round(x - size / 2)}" y1="${round(y)}" x2="${round(x + size / 2)}" y2="${round(y)}" stroke="${markColor}" stroke-width="1.2" stroke-linecap="round" />`);
            lines.push(`<line x1="${round(x)}" y1="${round(y - size / 2)}" x2="${round(x)}" y2="${round(y + size / 2)}" stroke="${markColor}" stroke-width="1.2" stroke-linecap="round" />`);
        }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidthPx}" height="${sheetHeightPx}" viewBox="0 0 ${sheetWidthPx} ${sheetHeightPx}">
  <rect x="0" y="0" width="${sheetWidthPx}" height="${sheetHeightPx}" fill="none" />
  ${lines.join("\n  ")}
</svg>`;
}

function buildSimpleJpegPdf(pages, dimensions) {
    const pageWidthPt = Math.round(dimensions.width * 72);
    const pageHeightPt = Math.round(dimensions.height * 72);
    const objects = [];
    const pageEntries = pages.map(function (_page, index) {
        const imageId = 3 + index * 3;
        return {
            imageId: imageId,
            contentId: imageId + 1,
            pageId: imageId + 2
        };
    });

    objects.push(buildPdfObject(1, `<< /Type /Catalog /Pages 2 0 R >>`));
    objects.push(buildPdfObject(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageEntries.map(function (entry) { return `${entry.pageId} 0 R`; }).join(" ")}] >>`));

    pages.forEach(function (page, index) {
        const entry = pageEntries[index];
        objects.push(buildPdfImageObject(entry.imageId, page.jpegBuffer, page.imageWidth, page.imageHeight));
        objects.push(buildPdfObject(entry.contentId, buildPdfPageContentObject(pageWidthPt, pageHeightPt, entry.imageId)));
        objects.push(buildPdfObject(entry.pageId, buildPdfPageObject(pageWidthPt, pageHeightPt, entry.contentId, entry.imageId)));
    });

    const bodyParts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
    const offsets = [0];
    let currentOffset = bodyParts[0].length;

    objects.forEach(function (object) {
        offsets.push(currentOffset);
        bodyParts.push(object);
        currentOffset += object.length;
    });

    const xrefOffset = currentOffset;
    const xrefLines = [
        `xref`,
        `0 ${objects.length + 1}`,
        `0000000000 65535 f `
    ];
    for (let i = 1; i < offsets.length; i += 1) {
        xrefLines.push(`${String(offsets[i]).padStart(10, "0")} 00000 n `);
    }
    const trailer = [
        `trailer`,
        `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
        `startxref`,
        String(xrefOffset),
        `%%EOF`
    ].join("\n");

    bodyParts.push(Buffer.from(xrefLines.join("\n") + "\n" + trailer, "utf8"));
    return Buffer.concat(bodyParts);
}

function buildPdfObject(objectId, body) {
    return Buffer.from(`${objectId} 0 obj\n${body}\nendobj\n`, "utf8");
}

function buildPdfImageObject(objectId, jpegBuffer, width, height) {
    const header = Buffer.from([
        `${objectId} 0 obj`,
        `<< /Type /XObject`,
        `/Subtype /Image`,
        `/Width ${width}`,
        `/Height ${height}`,
        `/ColorSpace /DeviceRGB`,
        `/BitsPerComponent 8`,
        `/Filter /DCTDecode`,
        `/Length ${jpegBuffer.length} >>`,
        `stream`
    ].join("\n") + "\n", "utf8");
    const footer = Buffer.from("\nendstream\nendobj\n", "utf8");
    return Buffer.concat([header, jpegBuffer, footer]);
}

function buildPdfPageContentObject(pageWidthPt, pageHeightPt, imageObjectId) {
    return [
        `<< /Length ${Buffer.byteLength(`q\n${pageWidthPt} 0 0 ${pageHeightPt} 0 0 cm\n/Im${imageObjectId} Do\nQ`, "utf8")} >>`,
        `stream`,
        `q`,
        `${pageWidthPt} 0 0 ${pageHeightPt} 0 0 cm`,
        `/Im${imageObjectId} Do`,
        `Q`,
        `endstream`
    ].join("\n");
}

function buildPdfPageObject(pageWidthPt, pageHeightPt, contentId, imageId) {
    return [
        `<< /Type /Page`,
        `/Parent 2 0 R`,
        `/MediaBox [0 0 ${pageWidthPt} ${pageHeightPt}]`,
        `/Resources << /ProcSet [/PDF /ImageC] /XObject << /Im${imageId} ${imageId} 0 R >> >>`,
        `/Contents ${contentId} 0 R >>`
    ].join(" ");
}

function normalizeNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return clamp(parsed, min, max);
}

function normalizeRotation(value) {
    return Number(value) === 90 ? 90 : 0;
}

function normalizeHexColor(value, fallback) {
    const text = String(value || "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(text)) {
        return text;
    }
    if (/^#[0-9a-fA-F]{3}$/.test(text)) {
        return text;
    }
    return fallback;
}

function getSheetPreset(sheetSize) {
    const presets = {
        "12x18": { width: 18, height: 12 },
        A4: { width: 11.69, height: 8.27 },
        A3: { width: 16.54, height: 11.69 },
        "13x19": { width: 19, height: 13 },
        Letter: { width: 11, height: 8.5 },
        Legal: { width: 14, height: 8.5 },
        Custom: { width: 18, height: 12 }
    };

    return presets[sheetSize] || presets["12x18"];
}

function clamp(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return min;
    }
    return Math.max(min, Math.min(max, numeric));
}

function round(value) {
    return Math.round(Number(value) || 0);
}

module.exports = {
    normalizePrintLayoutSettings,
    getSheetDimensions,
    getBusinessCardLayout,
    createBusinessCardPreviewBuffer,
    createBusinessCardSheetBuffer,
    buildSimpleJpegPdf
};
