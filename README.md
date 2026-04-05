# AJartivo Secure Delivery Backend

This backend serves AJartivo digital designs through protected Express routes with free-user limits, premium subscriptions, and verified individual purchases.

## What it does

- Creates individual design orders from `/create-order`
- Verifies design payments on `/verify-payment`
- Creates premium subscription orders from `/create-premium-order`
- Verifies premium subscription payments on `/verify-premium-payment`
- Returns user account summary from `/account/summary`
- Returns download access decisions from `/access/design/:id`
- Inserts verified purchases into the `purchases` table in Supabase
- Updates premium membership in the `users` table
- Serves files only through `/download/:id`
- Blocks downloads with `403` when account rules do not allow the design

## Required files

- `server.js`
- `routes/payment.js`
- `routes/download.js`
- `supabaseClient.js`

## Setup

1. Open `backend/.env.example`
2. Copy it to `backend/.env`
3. Fill in:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `RAZORPAY_KEY_ID`
   - `RAZORPAY_KEY_SECRET`
   - `PREMIUM_PLAN_PRICE`
4. Keep your frontend on `http://127.0.0.1:5500` or add your own origin to `FRONTEND_ORIGINS`

## Install and run

```bash
cd backend
npm install
npm start
```

Health check:

```bash
http://localhost:5000/health
```

## Frontend flow

1. User logs in with Supabase Auth
2. Frontend reads account summary and checks `/access/design/:id`
3. User either downloads directly, buys a design, or upgrades to premium
4. On payment success, frontend calls the matching verify endpoint
5. Backend verifies the Razorpay signature and updates `public.purchases` or `public.users`
6. File is downloaded only through `GET /download/:id`

## File delivery

- Local files should live inside the project `downloads/` folder
- Store the relative path in your design row as `download_link`
- Example: `downloads/poster-pack.zip`

## Supabase notes

- Use the service role key only in the backend
- Do not put the service role key in frontend JavaScript
- The frontend can use the publishable key for auth/session handling
- RLS should stay enabled on `users`, `purchases`, and `designs`
- Backend inserts and updates work because the service role bypasses RLS

## Recommended SQL

Run `supabase/marketplace_schema.sql` in the Supabase SQL editor.
