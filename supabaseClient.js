const { createClient } = require("@supabase/supabase-js");

const { config, hasSupabaseConfig } = require("./config");

const supabaseAdmin = hasSupabaseConfig()
    ? createClient(config.supabase.url, config.supabase.serviceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    })
    : null;

function getSupabaseAdminClient() {
    if (!supabaseAdmin) {
        const error = new Error("Supabase is not configured on the backend.");
        error.status = 500;
        throw error;
    }

    return supabaseAdmin;
}

module.exports = {
    getSupabaseAdminClient,
    supabaseAdmin
};
