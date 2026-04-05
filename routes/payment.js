const crypto = require("crypto");

const express = require("express");
const Razorpay = require("razorpay");

const { cleanText, config } = require("../config");
const { requireAuthenticatedUser } = require("../middleware/requireAuth");
const {
    requirePaymentConfigured
} = require("../middleware/requireConfig");
const {
    getDesignById,
    isPaidDesign
} = require("../services/designService");
const {
    findExistingPurchase,
    savePurchaseRecord
} = require("../services/purchaseService");
const { activatePremiumMembership, ensureUserProfile } = require("../services/userService");
const { asyncHandler, createHttpError } = require("../utils/http");

const router = express.Router();

router.post("/create-order", requirePaymentConfigured, requireAuthenticatedUser, asyncHandler(async function (req, res) {
    const designId = cleanText(req.body && req.body.design_id);
    if (!designId) {
        throw createHttpError(400, "Design ID is required.");
    }

    const design = await getDesignById(designId);
    if (!design) {
        throw createHttpError(404, "Design not found.");
    }

    if (!isPaidDesign(design)) {
        throw createHttpError(400, "This design does not require payment.");
    }

    const existingPurchase = await findExistingPurchase(req.authUser, design.id);
    if (existingPurchase) {
        return res.json({
            success: true,
            alreadyPurchased: true,
            design_id: design.id,
            download_url: `/download/${encodeURIComponent(design.id)}`
        });
    }

    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
        amount: design.amount_in_paise,
        currency: "INR",
        receipt: buildReceipt(design.id),
        notes: {
            design_id: String(design.id),
            user_id: req.authUser.id
        }
    });

    res.json({
        success: true,
        alreadyPurchased: false,
        key: config.razorpay.keyId,
        order_id: cleanText(order.id),
        amount: Number(order.amount || 0),
        currency: cleanText(order.currency) || "INR",
        design_id: design.id,
        design_title: design.title || "AJartivo Design"
    });
}));

router.post("/create-premium-order", requirePaymentConfigured, requireAuthenticatedUser, asyncHandler(async function (req, res) {
    const userProfile = await ensureUserProfile(req.authUser);

    if (userProfile.premium_active === true) {
        return res.json({
            success: true,
            alreadyPremium: true,
            premium_expiry: cleanText(userProfile.premium_expiry),
            amount: Math.round(config.premiumPlan.amountInRupees * 100),
            plan_name: config.premiumPlan.name
        });
    }

    const razorpay = getRazorpayClient();
    const amountInPaise = Math.round(config.premiumPlan.amountInRupees * 100);
    const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: buildPremiumReceipt(req.authUser.id),
        notes: {
            purchase_type: "premium_subscription",
            user_id: req.authUser.id
        }
    });

    res.json({
        success: true,
        alreadyPremium: false,
        key: config.razorpay.keyId,
        order_id: cleanText(order.id),
        amount: Number(order.amount || 0),
        currency: cleanText(order.currency) || "INR",
        plan_name: config.premiumPlan.name,
        duration_days: config.limits.premiumDurationDays
    });
}));

router.post("/verify-payment", requirePaymentConfigured, requireAuthenticatedUser, asyncHandler(async function (req, res) {
    const designId = cleanText(req.body && req.body.design_id);
    const orderId = cleanText(req.body && req.body.razorpay_order_id);
    const paymentId = cleanText(req.body && req.body.razorpay_payment_id);
    const signature = cleanText(req.body && req.body.razorpay_signature);

    if (!designId || !orderId || !paymentId || !signature) {
        throw createHttpError(400, "Missing required payment fields.");
    }

    const design = await getDesignById(designId);
    if (!design) {
        throw createHttpError(404, "Design not found.");
    }

    if (!isPaidDesign(design)) {
        throw createHttpError(400, "This design does not require payment.");
    }

    verifySignature(orderId, paymentId, signature);

    const razorpay = getRazorpayClient();
    const [razorpayOrder, razorpayPayment] = await Promise.all([
        razorpay.orders.fetch(orderId),
        razorpay.payments.fetch(paymentId)
    ]);

    if (!razorpayOrder || !razorpayPayment) {
        throw createHttpError(400, "Unable to verify payment details.");
    }

    if (cleanText(razorpayPayment.order_id) !== orderId) {
        throw createHttpError(400, "Payment order mismatch.");
    }

    if (Number(razorpayOrder.amount || 0) !== design.amount_in_paise) {
        throw createHttpError(400, "Order amount mismatch.");
    }

    if (cleanText(razorpayOrder.notes && razorpayOrder.notes.design_id) !== String(design.id)) {
        throw createHttpError(400, "Design mismatch detected.");
    }

    if (cleanText(razorpayOrder.notes && razorpayOrder.notes.user_id) !== req.authUser.id) {
        throw createHttpError(403, "Authenticated user does not match this order.");
    }

    const finalizedPayment = await capturePaymentIfNeeded(razorpay, razorpayPayment, design.amount_in_paise);
    if (!isSuccessfulPayment(finalizedPayment)) {
        throw createHttpError(400, "Payment is not successful.");
    }

    const existingPurchase = await findExistingPurchase(req.authUser, design.id);
    if (existingPurchase) {
        return res.json({
            success: true,
            alreadyPurchased: true,
            payment_id: cleanText(existingPurchase.payment_id || finalizedPayment.id),
            order_id: cleanText(existingPurchase.order_id || orderId),
            download_url: `/download/${encodeURIComponent(design.id)}`
        });
    }

    const purchaseRecord = await savePurchaseRecord({
        authUser: req.authUser,
        design: design,
        payment: finalizedPayment
    });

    res.json({
        success: true,
        alreadyPurchased: false,
        payment_id: cleanText(finalizedPayment.id),
        order_id: cleanText(razorpayOrder.id),
        amount: Number(finalizedPayment.amount || 0),
        purchase_id: cleanText(purchaseRecord && purchaseRecord.id),
        download_url: `/download/${encodeURIComponent(design.id)}`
    });
}));

router.post("/verify-premium-payment", requirePaymentConfigured, requireAuthenticatedUser, asyncHandler(async function (req, res) {
    const orderId = cleanText(req.body && req.body.razorpay_order_id);
    const paymentId = cleanText(req.body && req.body.razorpay_payment_id);
    const signature = cleanText(req.body && req.body.razorpay_signature);

    if (!orderId || !paymentId || !signature) {
        throw createHttpError(400, "Missing required premium payment fields.");
    }

    verifySignature(orderId, paymentId, signature);

    const razorpay = getRazorpayClient();
    const [razorpayOrder, razorpayPayment] = await Promise.all([
        razorpay.orders.fetch(orderId),
        razorpay.payments.fetch(paymentId)
    ]);

    if (!razorpayOrder || !razorpayPayment) {
        throw createHttpError(400, "Unable to verify premium payment details.");
    }

    if (cleanText(razorpayPayment.order_id) !== orderId) {
        throw createHttpError(400, "Payment order mismatch.");
    }

    if (cleanText(razorpayOrder.notes && razorpayOrder.notes.purchase_type) !== "premium_subscription") {
        throw createHttpError(400, "Invalid premium subscription order.");
    }

    if (cleanText(razorpayOrder.notes && razorpayOrder.notes.user_id) !== req.authUser.id) {
        throw createHttpError(403, "Authenticated user does not match this premium order.");
    }

    const expectedAmount = Math.round(config.premiumPlan.amountInRupees * 100);
    if (Number(razorpayOrder.amount || 0) !== expectedAmount) {
        throw createHttpError(400, "Premium order amount mismatch.");
    }

    const finalizedPayment = await capturePaymentIfNeeded(razorpay, razorpayPayment, expectedAmount);
    if (!isSuccessfulPayment(finalizedPayment)) {
        throw createHttpError(400, "Premium payment is not successful.");
    }

    const updatedProfile = await activatePremiumMembership(req.authUser);

    res.json({
        success: true,
        payment_id: cleanText(finalizedPayment.id),
        order_id: cleanText(razorpayOrder.id),
        premium_expiry: cleanText(updatedProfile.premium_expiry),
        account: {
            is_premium: updatedProfile.is_premium,
            premium_active: updatedProfile.premium_active,
            free_download_count: Number(updatedProfile.free_download_count || 0),
            free_download_remaining: Number(updatedProfile.free_download_remaining || 0),
            weekly_premium_download_count: Number(updatedProfile.weekly_premium_download_count || 0),
            weekly_premium_remaining: Number(updatedProfile.weekly_premium_remaining || 0),
            weekly_reset_date: cleanText(updatedProfile.weekly_reset_date)
        }
    });
}));

function getRazorpayClient() {
    return new Razorpay({
        key_id: config.razorpay.keyId,
        key_secret: config.razorpay.keySecret
    });
}

function verifySignature(orderId, paymentId, signature) {
    const expectedSignature = crypto
        .createHmac("sha256", config.razorpay.keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

    if (!safeCompare(expectedSignature, signature)) {
        throw createHttpError(400, "Invalid payment signature.");
    }
}

async function capturePaymentIfNeeded(razorpay, payment, amountInPaise) {
    const status = cleanText(payment && payment.status).toLowerCase();
    if (status === "captured") {
        return payment;
    }

    if (status !== "authorized") {
        return payment;
    }

    return razorpay.payments.capture(
        cleanText(payment.id),
        Number(amountInPaise),
        cleanText(payment.currency || "INR")
    );
}

function isSuccessfulPayment(payment) {
    const status = cleanText(payment && payment.status).toLowerCase();
    return status === "captured" || status === "authorized";
}

function safeCompare(expected, actual) {
    const left = Buffer.from(cleanText(expected), "utf8");
    const right = Buffer.from(cleanText(actual), "utf8");

    if (!left.length || left.length !== right.length) {
        return false;
    }

    return crypto.timingSafeEqual(left, right);
}

function buildReceipt(designId) {
    return `aj_${cleanText(designId)}_${Date.now()}`.slice(0, 40);
}

function buildPremiumReceipt(userId) {
    return `aj_premium_${cleanText(userId)}_${Date.now()}`.slice(0, 40);
}

module.exports = router;
