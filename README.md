# AJartivo Backend

This backend now supports a professional Hugging Face Space integration for background removal.

## What is included

- `POST /api/remove-bg`
- `multer` image upload handling
- `@gradio/client` integration with `mr-singh/bg-remover`
- JSON response with processed image URL and data URL
- MIME/type validation and file-size limits
- CORS for local and production frontend origins
- Existing PhotoRoom route kept as a backup for future use

## Folder structure

```text
backend/
  api/
    index.js
  middleware/
    requireConfig.js
  routes/
    removeBg.js
    photoRoom.js
    ...
  services/
    hfRemoveBgService.js
  utils/
    http.js
    imageValidation.js
  server.js
  config.js
  .env
  .env.example
  package.json
```

## Environment variables

Set these in `backend/.env` or in Render environment settings:

```env
PORT=5000
FRONTEND_ORIGINS=http://127.0.0.1:5500,http://localhost:5500,https://your-vercel-frontend.vercel.app

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
PHOTOROOM_API_KEY=

HF_REMOVE_BG_SPACE_ID=mr-singh/bg-remover
HF_REMOVE_BG_API_NAME=/remove_bg
HF_REMOVE_BG_MAX_FILE_SIZE_MB=12
HF_TOKEN=

R2_ACCESS_KEY=
R2_SECRET_KEY=
R2_BUCKET=
R2_ENDPOINT=
R2_PUBLIC_URL=
```

Notes:

- `HF_TOKEN` is optional for the public Space, but keep it ready if you ever make the Space private.
- `PHOTOROOM_API_KEY` stays in the project as a backup flow.

## Install

```bash
cd backend
npm install
```

The new dependencies are:

- `@gradio/client`
- `multer`

## Run locally

```bash
npm start
```

Health check:

```bash
GET http://localhost:5000/health
```

## API

### `POST /api/remove-bg`

Request:

- `Content-Type: multipart/form-data`
- field name: `image`

Example using `FormData`:

```js
const formData = new FormData();
formData.append("image", file);

const response = await fetch("https://your-render-backend.onrender.com/api/remove-bg", {
  method: "POST",
  body: formData
});

const data = await response.json();
console.log(data);
```

Success response:

```json
{
  "success": true,
  "message": "Background removed successfully.",
  "source": "huggingface-space",
  "spaceId": "mr-singh/bg-remover",
  "apiName": "/remove_bg",
  "output": {
    "imageUrl": "https://...",
    "imageDataUrl": "data:image/png;base64,...",
    "mimeType": "image/png",
    "fileName": "sample.png",
    "size": 123456
  }
}
```

## Frontend usage

In your frontend, send the file as `image`:

```js
const formData = new FormData();
formData.append("image", fileInput.files[0]);

const response = await fetch("https://your-render-backend.onrender.com/api/remove-bg", {
  method: "POST",
  body: formData
});

const payload = await response.json();

if (!response.ok) {
  throw new Error(payload.error || "Background removal failed.");
}

const previewUrl = payload.output.imageDataUrl || payload.output.imageUrl;
imagePreview.src = previewUrl;
```

If you need the image for canvas work, prefer `imageDataUrl` because it stays same-origin safe.

## Deployment on Render

1. Create a new Render Web Service.
2. Set the root directory to `Backend Services/backend`.
3. Build command:

```bash
npm install
```

4. Start command:

```bash
npm start
```

5. Add the environment variables from the section above.
6. Make sure `FRONTEND_ORIGINS` includes your Vercel frontend URL.

## Deployment on Vercel

This backend already supports the Vercel function entry point through `api/index.js`.

If you deploy this folder on Vercel, keep:

- `api/index.js`
- `server.js`

## Notes

- The PhotoRoom route is still present in `routes/photoRoom.js` as a backup.
- The new Hugging Face flow is the clean production path for `POST /api/remove-bg`.
- File-size limits and MIME validation are handled before the Space call.
