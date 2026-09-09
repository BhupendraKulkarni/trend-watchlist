# Trend Watchlist Setup

1. Create a Firebase project at console.firebase.google.com
2. Enable Firestore Database (production mode)
3. Enable Authentication -> Email/Password sign-in method, then add yourself as a user
   (Authentication -> Users -> Add user) — this is what lets you sign in on the
   dashboard to add/close positions.
4. Project Settings -> Service Accounts -> Generate new private key -> downloads a JSON file
5. Copy that JSON's full content into a GitHub repo secret named FIREBASE_SERVICE_ACCOUNT
6. In Firebase Console -> Firestore -> Rules, paste the contents of firestore.rules
7. Push this repo to GitHub -> go to Actions tab -> run "Daily Stock Scan" manually once
8. In dashboard-live.html, fill in your real Firebase config (apiKey, authDomain,
   projectId) near the top of the <script> section
9. Open dashboard-live.html, sign in with the email/password from step 3, and use
   "Mark as bought (IN)" to log a position after you actually buy it on your broker.

Exit rules applied automatically each day by the scan:
- Price <= entry - 8%  -> OUT, exit now
- Price >= entry + 20% -> TARGET HIT, book profit
- Otherwise            -> IN, hold
