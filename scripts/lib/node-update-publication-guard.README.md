# Bootstrap publication guard / حارس نشر التهيئة

الافتراضي لكل عقدة هو منع النشر المستقل. تحضير local-main يتطلب طلب الزر الموجود؛ release consumer تتطلب حزمة العملية الخاصة، تعمل server-only لدورة واحدة ثم تخرج. نشر client المستقل لا يقبل إلا الحزمة نفسها مرة واحدة. لا تغير هذه الوحدة authority مهام الإصدار أو المنفذ المحمل أو التعافي القائم.

Standalone publication defaults to denial on every node. Local preparation consumes the existing button request; the release consumer permits only one exact server-only bootstrap cycle and exits. The client publishes explicitly and separately with the same packet. Existing release jobs and loaded activation/recovery executors retain their own authority.

## Packet / الحزمة

File: canonical absolute path beneath the project, inside an operation directory owned by the service with mode0700. File: regular, owner=service UID, mode0600, nlink1, maximum64KiB. Ancestors must satisfy the checked ownership/write boundary. Root-level `.env` or a symlink cannot serve as a packet. No environment flag grants an exception.

Top-level schema: `nassaj-bootstrap-operation-packet/v1`. This is the approved operational packet, **not** the unfilled scratch binding template. Its operator must already hold the owner's specific approval and writer reservation; strings in JSON do not create either.

`bootstrapPublication` has exactly these fields:

- `schema`: `nassaj-bootstrap-publication/v1`
- `root`, `serviceUid`, `nodeIdentity` (the actual OS hostname)
- `oid`: exact final 40-hex main commit; `sequence`: positive safe integer; `group`: `event-` plus the sequence padded to16digits
- `clientBuildId`, `serverBuildId`
- `oldPid`, `oldStartTicks`, `healthOrigin` (`http://127.0.0.1:<port>` only)
- `oldLoadedBuildId`, `oldCapsuleSha256`, `oldSafeRestartSha256`
- `configBindingSha256`: SHA256 of `JSON.stringify(configBinding)` bytes
- `approvalReference`, `reservationReference`

All build/hash fields are lowercase64-hex. `configBinding` has schema `nassaj-bootstrap-config-binding/v1`, matching `root`, `oid`, approval/reservation references, and `database:{path,dev,ino,uid}` for the actual existing DB. Operational config receipts/hashes may be additional fields within this binding and are covered by its hash. Do not include secret bytes.

تطابق العملية القديمة فعليًا عبر UID/cwd/startTicks في `/proc` وhealth PID/build/startTicks، ثم provenance وmanifest وbytes الفعلية لـcapsule وsafe-restart. `nodeIdentity` هو hostname الحقيقي، وليس اسمًا تجميليًا. تتكرر المطابقة قبل queue ونشر العميل. مسار قاعدة البيانات وهوية inode مثبتان؛ sidecars تُفحص دون symlinks أو روابط خارجية، ويستخدم القارئ SQLite readonly دون immutable أو تهيئة التطبيق.

## Entry points and evidence / المداخل والدليل

- `consumeNewestPreview(root, operations, {domains:['server'], bootstrapPacket:absolutePath})`; CLI accepts `--bootstrap-packet` with its existing server-only environment scope. Uses existing builders and event locks. `requestServerControlPlane` returns `{actionId}` from the existing CLI's `id/queuedId`; an exact read-only SELECT rechecks the actual row's id/type/build/status.
- `promoteClientPreviewFromOid({root,expectedOid,group,buildId,bootstrapPacket})`; CLI promote accepts the same packet argument. Existing publisher/merge/smoke/ledger primitives remain in use. No client consumer branch remains.
- `readBootstrapPublicationPacket`, `assertBootstrapPublicationContext`, `assertBootstrapLoadedRuntime`, `inspectBootstrapServerAction`, `verifyBootstrapServerCandidate` are validation/read operations.
- `readBootstrapPublicationState` and `recordBootstrapPublicationState` use **the existing eventControl file**, not a second journal. The write operation requires the existing event mutation lock. Its section binds `packetSha256`, `configBindingSha256`, server claim/queue_intent/prepared, exact request/actionId, and client intent/published.

A prepared replay checks the actual request, consumer state, retained candidate provenance/control-manifest hash, and the same existing pending/failed action row. It never requeues or rebuilds. An interrupted claim or queue_intent refuses automatic restart of the operation until existing evidence is reconciled; do not delete it to obtain another attempt. A client intent may settle only when actual live provenance, asset closure, computed build identity, and the existing served ledger prove that exact publication; otherwise it refuses to publish again. Terminal state closes the exception. The normal capsule still verifies target execution integrity before activation.

يُحجز الحدث أثناء طلب صف التفعيل وكتابة prepared لمنع انتقاله لهدف جديد. لا يستعمل القارئ SQLite تطبيقًا أو migrations؛ يقرأ الأعمدة الأربعة المحددة فقط من الصف الحالي. لا schema أو PRAGMA write أو DB restore.

## Verification limits / حدود التحقق

Unit fixtures use a synthetic HTTP child, actual `/proc` process identity, private SQLite, and actual event locks. Publisher tests exercise the original exchange/smoke/ledger path with synthetic build inputs. They do not prove real node credentials, UI compatibility, final artifact identity or live activation. Rebuild and test the exact final OID before applying the operational packet. Server candidate-only builds remain allowed, while new legacy candidate activation through command-board routes is rejected; maintenance of the already-loaded matching generation and existing recovery remain separate.

## Local bootstrap ordering / ترتيب تهيئة المحلي

Complete the packet server producer and explicit client publication while the trusted mode is still `release`; bind the existing configuration and proposed `local-main` configuration separately in the reviewed operation's config receipts. Only then apply the CAS mode flip. After the flip, use only the already prepared exact action through the previously loaded authorized route, or restore the prior config through its preserved CAS evidence. The new producer does not accept `local-main` as a bootstrap exception. No placeholder OID or approval string authorizes an operation.

يكتمل تحضير السيرفر ونشر العميل الصريح في وضع `release` أولًا، ثم يُطبَّق تغيير الإعداد إلى `local-main` عبر CAS. تُربط حالة الإعداد السابقة والمقترحة بإيصالات العملية. بعد التغيير لا يُعاد التحضير؛ يُستعمل الطلب المطابق المحضّر مسبقًا عبر المسار القديم المحمّل، أو تُستعاد الإعدادات بدليلها المحفوظ.

The database may be outside the project. Its exact canonical path/dev/ino/UID must match an open FD of the pinned old process before and after the read-only SELECT. No initial environment variable or guessed default is required. Ancestor ownership and modes follow the same private service-owned 0700 boundary rule as PM2; exposed writable ancestors before that boundary are rejected. Descendant 0775 directories inside the private boundary are supported without chmod. The caller rechecks the ancestor identities across SELECT; missing or replaced DB descriptors fail closed. No environment contents are read or logged.

يمكن أن تكون قاعدة البيانات خارج المشروع تحت HOME. يُثبت القارئ مسارها وinode من FD مفتوح في العملية القديمة قبل القراءة وبعدها، ويفحص هوية الآباء وحدود الخصوصية؛ لا ينقل البيانات ولا يغيّر المودات ولا يقرأ البيئة.

New command-board OID-v1 requests cannot launch activation. Existing receipt reconciliation and authorized executor recovery remain available; local pair activation requires its exact button row and consent. Standalone activation CLI accepts only matching `prepared` activation recovery or `rollback_prepared` rollback recovery, never a terminal retry or fresh downgrade. Client bootstrap replay revalidates asset closure and build identity with the exact snapshot contract before settling the existing intent.
