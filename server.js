const cors = require("cors");
const express = require("express");

const { config, maskCredential } = require("./config");
const adminRoutes = require("./routes/admin");
const imageConverterRoutes = require("./routes/imageConverter");
const removeBgRoutes = require("./routes/removeBg");
const photoRoomRoutes = require("./routes/photoRoom");
const downloadRoutes = require("./routes/download");
const paymentRoutes = require("./routes/payment");
const printLayoutRoutes = require("./routes/printLayout");
const platformRoutes = require("./routes/platform");
const { errorHandler, notFoundHandler } = require("./utils/http");
const sitemapRoutes = require("./routes/sitemap");

const app = express();
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || config.frontendOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error("Origin not allowed by CORS."));
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-File-Name", "X-File-Type", "X-Upload-Kind"],
    exposedHeaders: ["Content-Disposition"]
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(express.json({ limit: "1mb" }));

app.get("/health", function (_req, res) {
    res.json({
        success: true,
        service: "AJartivo backend",
        port: config.port
    });
});

app.use(paymentRoutes);
app.use(downloadRoutes);
app.use(imageConverterRoutes);
app.use(removeBgRoutes);
app.use(photoRoomRoutes);
app.use(printLayoutRoutes);
app.use(adminRoutes);
app.use(platformRoutes);
app.use(sitemapRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

if (require.main === module && !process.env.VERCEL) {
    app.listen(config.port, function () {
        console.log(`[AJartivo Backend] running on http://localhost:${config.port}`);
        console.log("[AJartivo Backend] Razorpay config", {
            razorpayKeyId: maskCredential(config.razorpay.keyId),
            razorpaySecretLoaded: Boolean(config.razorpay.keySecret)
        });
        console.log("[AJartivo Backend] R2 config", {
            r2Endpoint: config.r2.endpoint,
            r2PublicUrl: config.r2.publicUrl,
            r2BucketName: config.r2.bucketName,
            r2AccessKey: maskCredential(config.r2.accessKey)
        });
        console.log("[AJartivo Backend] PhotoRoom config", {
            photoRoomApiUrl: config.photoRoom.apiBaseUrl,
            photoRoomApiKey: maskCredential(config.photoRoom.apiKey)
        });
        console.log("[AJartivo Backend] Hugging Face remove-bg config", {
            spaceId: config.hfRemoveBg.spaceId,
            apiName: config.hfRemoveBg.apiName,
            tokenLoaded: Boolean(config.hfRemoveBg.token),
            maxFileSizeMb: Math.round(config.hfRemoveBg.maxFileSizeBytes / (1024 * 1024))
        });
        console.log("[AJartivo Backend] Allowed origins", config.frontendOrigins);
    });
}
