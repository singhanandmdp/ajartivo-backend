function parseMultipartRequest(req) {
    const contentType = String(req && req.headers && req.headers["content-type"] || "").trim();
    const buffer = Buffer.isBuffer(req && req.body) ? req.body : Buffer.alloc(0);
    const boundary = readBoundary(contentType);

    if (!boundary) {
        return {
            fields: {},
            files: {}
        };
    }

    if (!buffer.length) {
        throw new Error("Multipart request body is empty.");
    }

    const parts = buffer
        .toString("binary")
        .split(`--${boundary}`)
        .slice(1, -1);

    const fields = {};
    const files = {};

    parts.forEach(function (part) {
        const normalizedPart = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
        if (!normalizedPart) {
            return;
        }

        const headerSeparatorIndex = normalizedPart.indexOf("\r\n\r\n");
        if (headerSeparatorIndex < 0) {
            return;
        }

        const rawHeaderBlock = normalizedPart.slice(0, headerSeparatorIndex);
        const rawBodyBlock = normalizedPart.slice(headerSeparatorIndex + 4);
        const headers = parseHeaders(rawHeaderBlock);
        const disposition = parseContentDisposition(headers["content-disposition"] || "");
        const fieldName = String(disposition.name || "").trim();

        if (!fieldName) {
            return;
        }

        const bodyBinary = rawBodyBlock.replace(/\r\n$/, "");
        const bodyBuffer = Buffer.from(bodyBinary, "binary");

        if (disposition.filename) {
            files[fieldName] = {
                fieldName: fieldName,
                fileName: disposition.filename,
                contentType: String(headers["content-type"] || "application/octet-stream").trim(),
                buffer: bodyBuffer,
                size: bodyBuffer.length
            };
            return;
        }

        fields[fieldName] = bodyBuffer.toString("utf8");
    });

    return {
        fields: fields,
        files: files
    };
}

function readBoundary(contentType) {
    const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    return match ? String(match[1] || match[2] || "").trim() : "";
}

function parseHeaders(rawHeaderBlock) {
    return String(rawHeaderBlock || "")
        .split("\r\n")
        .reduce(function (accumulator, line) {
            const separatorIndex = line.indexOf(":");
            if (separatorIndex < 0) {
                return accumulator;
            }

            const key = line.slice(0, separatorIndex).trim().toLowerCase();
            const value = line.slice(separatorIndex + 1).trim();
            if (key) {
                accumulator[key] = value;
            }
            return accumulator;
        }, {});
}

function parseContentDisposition(value) {
    return String(value || "")
        .split(";")
        .slice(1)
        .reduce(function (accumulator, entry) {
            const separatorIndex = entry.indexOf("=");
            if (separatorIndex < 0) {
                return accumulator;
            }

            const key = entry.slice(0, separatorIndex).trim().toLowerCase();
            const rawValue = entry.slice(separatorIndex + 1).trim();
            accumulator[key] = rawValue.replace(/^"|"$/g, "");
            return accumulator;
        }, {});
}

module.exports = {
    parseMultipartRequest
};
