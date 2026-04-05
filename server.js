const cors = require("cors");
const express = require("express");

const { config, maskCredential } = require("./config");
const adminRoutes = require("./routes/admin");
const downloadRoutes = require("./routes/download");
const paymentRoutes = require("./routes/payment");
const { errorHandler, notFoundHandler } = require("./utils/http");

const app = express();

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || config.frontendOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error("Origin not allowed by CORS."));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-File-Name", "X-File-Type", "X-Upload-Kind"],
    exposedHeaders: ["Content-Disposition"]
}));

app.use(express.json({ limit: "1mb" }));

app.get("/health", function (_req, res) {
    res.json({
        success: true,
        service: "AJartivo payments",
        port: config.port
    });
});

app.use(paymentRoutes);
app.use(downloadRoutes);
app.use(adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

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
    console.log("[AJartivo Backend] Allowed origins", config.frontendOrigins);
});

module.exports = app;
