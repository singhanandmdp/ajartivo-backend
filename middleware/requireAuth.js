const { cleanText } = require("../config");
const { getSupabaseAdminClient } = require("../supabaseClient");
const { createHttpError } = require("../utils/http");

async function requireAuthenticatedUser(req, _res, next) {
    try {
        const token = extractBearerToken(req.headers.authorization);
        if (!token) {
            return next(createHttpError(401, "Authentication required."));
        }

        const supabase = getSupabaseAdminClient();
        const { data, error } = await supabase.auth.getUser(token);

        if (error || !data || !data.user) {
            return next(createHttpError(401, "Invalid or expired Supabase token."));
        }

        const user = data.user;
        req.authUser = {
            id: cleanText(user.id),
            email: cleanText(user.email).toLowerCase(),
            name: cleanText(
                user.user_metadata && (
                    user.user_metadata.full_name ||
                    user.user_metadata.name
                )
            )
        };

        req.authToken = token;
        next();
    } catch (error) {
        next(error.status ? error : createHttpError(500, "Authentication failed."));
    }
}

async function requireAdminUser(req, _res, next) {
    try {
        const user = req.authUser;
        if (!user || !cleanText(user.id || user.email)) {
            return next(createHttpError(401, "Authentication required."));
        }

        const supabase = getSupabaseAdminClient();
        const profile = await findProfileForUser(supabase, user);
        const role = cleanText(profile && profile.role).toLowerCase();

        if (role !== "admin") {
            return next(createHttpError(403, "Admin access required."));
        }

        req.authProfile = profile || null;
        next();
    } catch (error) {
        next(error.status ? error : createHttpError(500, "Admin verification failed."));
    }
}

function extractBearerToken(headerValue) {
    const value = cleanText(headerValue);
    if (!value.toLowerCase().startsWith("bearer ")) {
        return "";
    }

    return cleanText(value.slice(7));
}

async function findProfileForUser(supabase, user) {
    const userId = cleanText(user && user.id);
    const email = cleanText(user && user.email).toLowerCase();

    if (userId) {
        const byId = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
        if (byId.error) {
            throw byId.error;
        }
        if (byId.data) {
            return byId.data;
        }
    }

    if (email) {
        const byEmail = await supabase.from("profiles").select("*").eq("email", email).maybeSingle();
        if (byEmail.error) {
            throw byEmail.error;
        }
        if (byEmail.data) {
            return byEmail.data;
        }
    }

    return null;
}

module.exports = {
    extractBearerToken,
    requireAdminUser,
    requireAuthenticatedUser
};
