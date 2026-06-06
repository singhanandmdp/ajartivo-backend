const express = require("express");
const multer = require("multer");

const { config } = require("../config");
const { requireHfRemoveBgConfigured } = require("../middleware/requireConfig");
const { asyncHandler, createHttpError } = require("../utils/http");
const { isSupportedImageMimeType, validateImageUpload } = require("../utils/imageValidation");
const { removeBackgroundViaSpace } = require("../services/hfRemoveBgService");

const router = express.Router();
const maxFileSizeMb = Math.max(1, Math.round(config.hfRemoveBg.maxFileSizeBytes / (1024 * 1024)));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: config.hfRemoveBg.maxFileSizeBytes,
        files: 1
    },
    fileFilter: function (_req, file, cb) {
        if (!isSupportedImageMimeType(file && file.mimetype)) {
            cb(createHttpError(415, "Only JPEG, PNG, WebP, GIF, and AVIF images are allowed."));
            return;
        }

        cb(null, true);
    }
});

router.post(
    "/api/remove-bg",
    requireHfRemoveBgConfigured,
    uploadSingleImage,
    asyncHandler(async function (req, res) {
        if (!req.file) {
            throw createHttpError(400, "Image file is missing.");
        }

        const validation = validateImageUpload(req.file);
        if (!validation.ok) {
            throw createHttpError(validation.status, validation.message);
        }

        const output = await removeBackgroundViaSpace({
            buffer: validation.buffer,
            mimeType: validation.mimeType,
            fileName: req.file.originalname
        });

        res.json({
            success: true,
            message: "Background removed successfully.",
            source: "huggingface-space",
            spaceId: config.hfRemoveBg.spaceId,
            apiName: config.hfRemoveBg.apiName,
            output: {
                imageUrl: output.url || "",
                imageDataUrl: output.dataUrl || "",
                mimeType: output.mimeType || validation.mimeType,
                fileName: output.fileName || req.file.originalname || "ajartivo.png",
                size: Number(output.size) || 0
            }
        });
    })
);

function uploadSingleImage(req, res, next) {
    upload.single("image")(req, res, function (error) {
        if (!error) {
            next();
            return;
        }

        next(normalizeMulterError(error));
    });
}

function normalizeMulterError(error) {
    if (!error) {
        return createHttpError(400, "Upload failed.");
    }

    if (error.code === "LIMIT_FILE_SIZE") {
        return createHttpError(413, `Image must be ${maxFileSizeMb} MB or smaller.`);
    }

    if (error.code === "LIMIT_UNEXPECTED_FILE") {
        return createHttpError(400, 'Send the image in the "image" form-data field.');
    }

    if (error.code === "LIMIT_FILE_COUNT") {
        return createHttpError(400, "Only one image file is allowed.");
    }

    return createHttpError(error.status || 400, error.message || "Upload failed.");
}

module.exports = router;
