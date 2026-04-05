const {
    getR2ConfigurationError,
    getRazorpayConfigurationError,
    getSupabaseConfigurationError
} = require("../config");
const { createHttpError } = require("../utils/http");

function requireSupabaseConfigured(_req, _res, next) {
    const configError = getSupabaseConfigurationError();
    if (configError) {
        return next(createHttpError(500, configError));
    }

    next();
}

function requireRazorpayConfigured(_req, _res, next) {
    const configError = getRazorpayConfigurationError();
    if (configError) {
        return next(createHttpError(500, configError));
    }

    next();
}

function requireR2Configured(_req, _res, next) {
    const configError = getR2ConfigurationError();
    if (configError) {
        return next(createHttpError(500, configError));
    }

    next();
}

function requirePaymentConfigured(req, res, next) {
    requireSupabaseConfigured(req, res, function (error) {
        if (error) {
            next(error);
            return;
        }

        requireRazorpayConfigured(req, res, next);
    });
}

module.exports = {
    requireR2Configured,
    requirePaymentConfigured,
    requireRazorpayConfigured,
    requireSupabaseConfigured
};
