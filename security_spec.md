# FaixaSegura — Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants & Relationship Mapping
1. **Default-Deny Catch-All**: Every path not explicitly matched under `/databases/{database}/documents` is unconditionally denied (`allow read, write: if false;`).
2. **Master Source of Truth (`/users/{userId}`)**:
   - A user anchor document `/users/{userId}` can only be read, created, or updated by the authenticated user whose `request.auth.uid == userId` AND `request.auth.token.email_verified == true`.
   - Every subcollection document (`/users/{userId}/private/{docId}`, `/users/{userId}/history/{entryId}`, `/users/{userId}/parcels/{parcelId}`) requires the parent `/users/{userId}` document to exist (`exists(...)` or atomic `existsAfter(...)` on initial batch registration) and its `uid` field to match `request.auth.uid`.
3. **PII Isolation (Split Collection Strategy)**:
   - `/users/{userId}` stores ONLY non-PII fields (`uid`, `displayName`, `preferredDico`, `createdAt`, `updatedAt`).
   - Sensitive PII (`email`, `nif`, `phone`) is strictly isolated in `/users/{userId}/private/{docId}` (`docId == 'profile'`) with `get`/`create`/`update` restricted exclusively to the verified owner (`request.auth.uid == userId`). `list` and `delete` are denied on `/private/{docId}`.
4. **Temporal & Identity Immutability**:
   - All `createdAt` and `updatedAt` fields must equal `request.time` on `create`.
   - On `update`, `updatedAt == request.time`, `createdAt == resource.data.createdAt`, and `uid == resource.data.uid`.
5. **Terminal State Locking**:
   - In `/users/{userId}/history/{entryId}`, once `resource.data.status == 'ARCHIVED'`, no further updates are permitted.
6. **Secure List Queries**:
   - `allow list` on `/users/{userId}/history/{entryId}` and `/users/{userId}/parcels/{parcelId}` explicitly enforces `request.auth.uid == userId && resource.data.uid == request.auth.uid` with zero `get()`/`exists()` calls inside `list`.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return `PERMISSION_DENIED`)
1. **Unauthenticated Write**: `auth = null` attempting `create` on `/users/user_1`.
2. **Unverified Email Spoof**: `auth = { uid: 'user_1', token: { email_verified: false } }` attempting `create` on `/users/user_1`.
3. **Cross-Tenant Identity Spoofing**: `auth.uid = 'attacker_9'` attempting `create` on `/users/victim_1/history/h_1` with `uid: 'victim_1'`.
4. **Payload UID Mismatch**: `auth.uid = 'user_1'` attempting `create` on `/users/user_1/history/h_1` with `uid: 'user_2'`.
5. **Orphaned Subcollection Write**: `auth.uid = 'user_no_parent'` attempting `create` on `/users/user_no_parent/history/h_1` without `/users/user_no_parent` existing.
6. **Shadow / Ghost Field Injection**: `create` on `/users/user_1` containing extra key `{ isAdmin: true }`.
7. **PII Cross-User Read**: `auth.uid = 'user_2'` attempting `get` on `/users/user_1/private/profile`.
8. **ID Poisoning (2KB Path Segment)**: `create` on `/users/user_1/history/<200-char-invalid-id$%>`.
9. **Value Poisoning on Update**: `update` on `/users/user_1` changing `displayName` to a 500-character string or integer `12345`.
10. **Client-Forged Timestamp**: `create` on `/users/user_1/history/h_1` with `createdAt` set to a past timestamp instead of `request.time`.
11. **Terminal State Re-Open**: `update` on `/users/user_1/history/h_archived` when `existing().status == 'ARCHIVED'`.
12. **Unauthorized Cross-Tenant List Query**: `auth.uid = 'user_2'` executing `list` on `/users/user_1/history`.
