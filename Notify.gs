// ---------- Notification emails (2026-10-09) ----------
// The user: "the mail sent to the users to take actions, and the status updates on
// the request they created, has no design". Every email about a request is drawn
// here, in one layout, in the reader's own language (userLang_): the company band
// with the logo, what happened in one line, the amount on a slip that names who
// hands it to whom, the request's details, the cash worked through to the net
// (the same parts as cashCalcRows_ in the client), what it carries, where it
// stands, and one button that opens that very request in the app (?open=...,
// read by the client's openFromLink_). A plain-text copy goes with it.
// Sending is best-effort everywhere, as before: a mail failure never fails an action.

var NM_ = {
  en: {
    dir: 'ltr', org: 'Best Gas Carrier Co.', app: 'Cash Collection',
    tag: { action: 'Action needed', bad: 'Needs attention', good: 'Completed', info: 'Status update', warn: 'Alert' },
    kind: { car_to_location: 'Car to branch handover', location_to_cluster: 'Branch to area handover', cluster_to_collector: 'Area to collector handover', deposit: 'Bank deposit', batch: 'Area upload' },
    st: { pending: 'Waiting for receipt', pending_deputy: 'Waiting for the operations check', confirmed: 'Received', disputed: 'Disputed', returned: 'Returned for correction', rejected: 'Rejected', completed: 'Deposited', deputy_approved: 'Approved', approving: 'Being approved', voided: 'Cancelled' },
    ev: {
      confirm_receipt: { s: 'Confirm receipt: {amount} SAR from {from}', h: 'Cash is on its way to you', l: '{from} has handed you {amount} SAR. Count it, then confirm the amount you actually received.', b: 'Confirm receipt', t: 'action' },
      deputy_validate: { s: 'Check needed: {from}\'s handover of {amount} SAR', h: 'A handover is waiting for your check', l: '{from} is sending {amount} SAR to {to}. It reaches the collector only after you check it.', b: 'Review the request', t: 'action' },
      deputy_validate_rev: { s: 'Corrected handover (version {rev}) waiting for your check', h: 'A corrected handover is back for your check', l: '{from} corrected the handover you returned and sent it again: {amount} SAR to {to}.', b: 'Review the request', t: 'action' },
      returned: { s: 'Returned for correction: your handover of {amount} SAR', h: 'Your handover was returned', l: '{by} returned your handover of {amount} SAR to {to}. The cash is back with you: correct the request and send it again.', b: 'Correct and send again', t: 'bad' },
      confirmed: { s: 'Received in full: your handover of {amount} SAR', h: 'Your handover was received', l: '{to} confirmed receiving the full {amount} SAR.', b: 'View the request', t: 'good' },
      confirmed_short: { s: 'Received short: your handover of {declared} SAR', h: 'Your handover was received short', l: '{to} received {amount} SAR of the {declared} SAR you declared. The difference is recorded against this request.', b: 'View the request', t: 'bad' },
      confirmed_over: { s: 'Received over: your handover of {declared} SAR', h: 'Your handover was received with more cash', l: '{to} received {amount} SAR where you declared {declared} SAR. The difference is recorded against this request.', b: 'View the request', t: 'warn' },
      validated: { s: 'Checked and sent on: your handover of {amount} SAR', h: 'Your handover passed the operations check', l: '{by} checked your handover of {amount} SAR and sent it to {to} to receive.', b: 'View the request', t: 'good' },
      disputed: { s: 'Disputed: handover of {amount} SAR from {from}', h: 'A handover was disputed', l: '{by} disputed the handover of {amount} SAR from {from} to {to}. It stays on hold until finance or an administrator settles it.', b: 'Review the dispute', t: 'bad' },
      disputed_sender: { s: 'Your handover of {amount} SAR was disputed', h: 'Your handover was disputed', l: '{by} disputed your handover of {amount} SAR to {to}. Finance or an administrator will settle it.', b: 'View the request', t: 'bad' },
      resolved_confirm: { s: 'Dispute settled: handover of {amount} SAR accepted', h: 'The dispute was settled', l: '{by} settled the dispute and accepted the handover at {amount} SAR.', b: 'View the request', t: 'good' },
      resolved_reject: { s: 'Dispute settled: handover of {amount} SAR rejected', h: 'The handover was rejected', l: '{by} rejected the handover of {amount} SAR. Its cash went back to {from} to be handed over again.', b: 'View the request', t: 'bad' },
      shortfall: { s: 'Received short: {short} SAR missing on {no}', h: 'A handover was received short', l: '{to} received {amount} SAR of the {declared} SAR {from} declared.', b: 'Open the request', t: 'warn' },
      overage: { s: 'Received over: {short} SAR more on {no}', h: 'A handover was received with more cash', l: '{to} received {amount} SAR where {from} declared {declared} SAR.', b: 'Open the request', t: 'warn' },
      large_info: { s: 'Large handover received: {amount} SAR', h: 'A large handover was received', l: '{to} received {amount} SAR from {from}, above the {limit} SAR limit. Finance or an administrator gives it a second sign-off; nothing is needed from you.', b: 'View the request', t: 'info' },
      large: { s: 'Second sign-off needed: {amount} SAR', h: 'A large handover needs a second sign-off', l: '{to} received {amount} SAR from {from}, above the {limit} SAR limit. It has moved on; a second sign-off from finance or an administrator is still required.', b: 'Give the second sign-off', t: 'action' },
      stale: { s: 'Waiting {hours} hours: {amount} SAR not yet received', h: 'A handover has waited too long', l: '{from} handed over {amount} SAR to {to} {hours} hours ago and it has not been confirmed yet.', b: 'Open the request', t: 'warn' },
      held: { s: 'Held {hours} hours: {amount} SAR not passed on', h: 'Cash has been held too long', l: '{to} has held {amount} SAR for {hours} hours without passing it to the next step.', b: 'Open the request', t: 'warn' },
      batch_pending: { s: 'Area upload of {amount} SAR waiting for your approval', h: 'An area upload is waiting for your approval', l: '{from} uploaded the day of {place}: {amount} SAR in cash to hand over.', b: 'Review the upload', t: 'action' },
      batch_rejected: { s: 'Your area upload of {amount} SAR was rejected', h: 'Your area upload was rejected', l: '{by} rejected your upload of {amount} SAR. Correct it and send it again.', b: 'Correct the upload', t: 'bad' },
      batch_approved: { s: 'Approved: your area upload of {amount} SAR', h: 'Your area upload was approved', l: '{by} approved your upload of {amount} SAR. It is now on its way to the collectors.', b: 'View the upload', t: 'good' },
      risk: { s: 'High-severity report: {title}', h: 'A high-severity report was filed', l: '{by} filed a high-severity report. Review it in the risk register.', b: 'Open the register', t: 'warn' }
    },
    f: { no: 'Request number', kind: 'Type', from: 'From', to: 'To', place: 'Branch', area: 'Area', city: 'City', created: 'Created', status: 'Status now', declared: 'Declared', received: 'Received', short: 'Short', over: 'Over', reason: 'Reason', note: 'Note', disputeNote: 'Dispute note', resolution: 'Settlement note', correction: 'What was corrected', rev: 'Version', prev: 'Previous version', ref: 'Bank reference', hours: 'Waiting', limit: 'Limit', title: 'Title', desc: 'Description', by: 'Reported by', severity: 'Severity', amount: 'Amount', handedBy: 'Handed over by', receivedBy: 'Received by' },
    sec: { details: 'Request details', calc: 'How the amount is worked out', carries: 'What it carries', stages: 'Where it stands', more: 'and {n} more' },
    calc: { storeCash: 'Branch cash sales', carCash: 'Car cash sales', posCash: 'POS cash sales', otherCash: 'Other collections', creditFee: 'Credit customers\' delivery fees', chFee: 'Sales channels\' delivery fees', over: 'Received over', totalIn: 'Total collected', delivery: 'Delivery fees paid to the bank (before VAT)', credit: 'Credit sales', creditFeeOff: 'Credit delivery fees, paid later', commission: 'Customer commissions', chCom: 'Sales channel commissions', discount: 'Discounts', transfer: 'Customer bank transfers', expense: 'Expenses paid out', banked: 'POS settlements (الموازنات), banked by the device', short: 'Received short', totalOut: 'Total deductions', diff: 'Unexplained difference', net: 'Net cash' },
    stg: ['Entered', 'Branch', 'Area', 'Operations check', 'Collector', 'Bank'],
    sar: 'SAR', amountTo: 'to hand over', amountGot: 'received',
    fallback: 'If the button does not open, copy this link into your browser:',
    why: 'You receive this because you take part in this request in Best Gas Cash Collection. It was sent automatically; replies are not read.',
    hi: 'Hello {name},'
  },
  ar: {
    dir: 'rtl', org: 'شركة الناقل الأفضل للغاز', app: 'تحصيل النقدية',
    tag: { action: 'مطلوب إجراء منك', bad: 'يحتاج انتباهك', good: 'تم بنجاح', info: 'تحديث الحالة', warn: 'تنبيه' },
    kind: { car_to_location: 'تسليم من السيارة إلى الفرع', location_to_cluster: 'تسليم من الفرع إلى المنطقة', cluster_to_collector: 'تسليم من المنطقة إلى المحصّل', deposit: 'إيداع بنكي', batch: 'رفع بيانات المنطقة' },
    st: { pending: 'بانتظار الاستلام', pending_deputy: 'بانتظار تحقق العمليات', confirmed: 'تم الاستلام', disputed: 'معترض عليه', returned: 'أُعيد للتصحيح', rejected: 'مرفوض', completed: 'تم الإيداع', deputy_approved: 'معتمد', approving: 'قيد الاعتماد', voided: 'ملغى' },
    ev: {
      confirm_receipt: { s: 'أكّد الاستلام: {amount} ريال من {from}', h: 'نقدية في طريقها إليك', l: 'سلّمك {from} مبلغ {amount} ريال. عُدّ المبلغ ثم أكّد ما استلمته فعلاً.', b: 'تأكيد الاستلام', t: 'action' },
      deputy_validate: { s: 'مطلوب تحققك: تسليم {from} بمبلغ {amount} ريال', h: 'طلب تسليم بانتظار تحققك', l: 'يرسل {from} مبلغ {amount} ريال إلى {to}، ولا يصل إلى المحصّل إلا بعد تحققك.', b: 'مراجعة الطلب', t: 'action' },
      deputy_validate_rev: { s: 'طلب مصحَّح (النسخة {rev}) بانتظار تحققك', h: 'عاد إليك طلب مصحَّح للتحقق', l: 'صحّح {from} الطلب الذي أعدته وأرسله من جديد: {amount} ريال إلى {to}.', b: 'مراجعة الطلب', t: 'action' },
      returned: { s: 'أُعيد للتصحيح: طلب تسليمك بمبلغ {amount} ريال', h: 'أُعيد طلب تسليمك', l: 'أعاد {by} طلب تسليمك بمبلغ {amount} ريال إلى {to}. النقدية عادت إليك: صحّح الطلب وأرسله من جديد.', b: 'تصحيح وإعادة الإرسال', t: 'bad' },
      confirmed: { s: 'تم الاستلام كاملاً: تسليمك بمبلغ {amount} ريال', h: 'تم استلام تسليمك', l: 'أكّد {to} استلام المبلغ كاملاً: {amount} ريال.', b: 'عرض الطلب', t: 'good' },
      confirmed_short: { s: 'استُلم ناقصاً: تسليمك بمبلغ {declared} ريال', h: 'استُلم تسليمك بنقص', l: 'استلم {to} مبلغ {amount} ريال من أصل {declared} ريال أعلنتها. سُجّل الفرق على هذا الطلب.', b: 'عرض الطلب', t: 'bad' },
      confirmed_over: { s: 'استُلم بزيادة: تسليمك بمبلغ {declared} ريال', h: 'استُلم تسليمك بزيادة', l: 'استلم {to} مبلغ {amount} ريال بينما أعلنت {declared} ريال. سُجّل الفرق على هذا الطلب.', b: 'عرض الطلب', t: 'warn' },
      validated: { s: 'تم التحقق والإرسال: تسليمك بمبلغ {amount} ريال', h: 'اجتاز طلبك تحقق العمليات', l: 'تحقق {by} من تسليمك بمبلغ {amount} ريال وأرسله إلى {to} لاستلامه.', b: 'عرض الطلب', t: 'good' },
      disputed: { s: 'اعتراض: تسليم بمبلغ {amount} ريال من {from}', h: 'تم الاعتراض على تسليم', l: 'اعترض {by} على تسليم {amount} ريال من {from} إلى {to}. يبقى معلّقاً حتى تبتّ فيه المالية أو الإدارة.', b: 'مراجعة الاعتراض', t: 'bad' },
      disputed_sender: { s: 'اعتُرض على تسليمك بمبلغ {amount} ريال', h: 'تم الاعتراض على تسليمك', l: 'اعترض {by} على تسليمك بمبلغ {amount} ريال إلى {to}. ستبتّ فيه المالية أو الإدارة.', b: 'عرض الطلب', t: 'bad' },
      resolved_confirm: { s: 'حُسم الاعتراض: قُبل التسليم بمبلغ {amount} ريال', h: 'حُسم الاعتراض', l: 'حسم {by} الاعتراض وقبل التسليم بمبلغ {amount} ريال.', b: 'عرض الطلب', t: 'good' },
      resolved_reject: { s: 'حُسم الاعتراض: رُفض التسليم بمبلغ {amount} ريال', h: 'رُفض التسليم', l: 'رفض {by} التسليم بمبلغ {amount} ريال، وعادت النقدية إلى {from} ليسلّمها من جديد.', b: 'عرض الطلب', t: 'bad' },
      shortfall: { s: 'استلام ناقص: ينقص {short} ريال في {no}', h: 'استُلم تسليم بنقص', l: 'استلم {to} مبلغ {amount} ريال من أصل {declared} ريال أعلنها {from}.', b: 'فتح الطلب', t: 'warn' },
      overage: { s: 'استلام بزيادة: {short} ريال زيادة في {no}', h: 'استُلم تسليم بزيادة', l: 'استلم {to} مبلغ {amount} ريال بينما أعلن {from} مبلغ {declared} ريال.', b: 'فتح الطلب', t: 'warn' },
      large_info: { s: 'استُلم تسليم كبير: {amount} ريال', h: 'استُلم تسليم كبير', l: 'استلم {to} مبلغ {amount} ريال من {from}، وهو فوق حد {limit} ريال. تعطيه المالية أو الإدارة موافقة ثانية، ولا شيء مطلوب منك.', b: 'عرض الطلب', t: 'info' },
      large: { s: 'مطلوب موافقة ثانية: {amount} ريال', h: 'تسليم كبير يحتاج موافقة ثانية', l: 'استلم {to} مبلغ {amount} ريال من {from}، وهو فوق حد {limit} ريال. انتقل المبلغ للمرحلة التالية، ويبقى مطلوباً توقيع ثانٍ من المالية أو الإدارة.', b: 'إعطاء الموافقة الثانية', t: 'action' },
      stale: { s: 'بانتظار منذ {hours} ساعة: {amount} ريال لم يُستلم بعد', h: 'تسليم تأخر تأكيده', l: 'سلّم {from} مبلغ {amount} ريال إلى {to} قبل {hours} ساعة ولم يُؤكَّد استلامه بعد.', b: 'فتح الطلب', t: 'warn' },
      held: { s: 'محتفظ به منذ {hours} ساعة: {amount} ريال لم يُسلَّم', h: 'نقدية محتفظ بها لفترة طويلة', l: 'يحتفظ {to} بمبلغ {amount} ريال منذ {hours} ساعة دون تسليمه للمرحلة التالية.', b: 'فتح الطلب', t: 'warn' },
      batch_pending: { s: 'رفع بيانات منطقة بمبلغ {amount} ريال بانتظار اعتمادك', h: 'رفع بيانات منطقة بانتظار اعتمادك', l: 'رفع {from} يوم {place}: {amount} ريال نقداً للتسليم.', b: 'مراجعة الرفع', t: 'action' },
      batch_rejected: { s: 'رُفض رفع بياناتك بمبلغ {amount} ريال', h: 'رُفض رفع بياناتك', l: 'رفض {by} رفعك بمبلغ {amount} ريال. صحّحه وأرسله من جديد.', b: 'تصحيح الرفع', t: 'bad' },
      batch_approved: { s: 'اعتُمد رفع بياناتك بمبلغ {amount} ريال', h: 'اعتُمد رفع بياناتك', l: 'اعتمد {by} رفعك بمبلغ {amount} ريال، وهو الآن في طريقه إلى المحصّلين.', b: 'عرض الرفع', t: 'good' },
      risk: { s: 'بلاغ عالي الخطورة: {title}', h: 'سُجّل بلاغ عالي الخطورة', l: 'سجّل {by} بلاغاً عالي الخطورة. راجعه في سجل المخاطر.', b: 'فتح السجل', t: 'warn' }
    },
    f: { no: 'رقم الطلب', kind: 'النوع', from: 'من', to: 'إلى', place: 'الفرع', area: 'المنطقة', city: 'المدينة', created: 'تاريخ الإنشاء', status: 'الحالة الآن', declared: 'المُعلن', received: 'المُستلم', short: 'النقص', over: 'الزيادة', reason: 'السبب', note: 'ملاحظة', disputeNote: 'سبب الاعتراض', resolution: 'ملاحظة الحسم', correction: 'ما تم تصحيحه', rev: 'النسخة', prev: 'النسخة السابقة', ref: 'المرجع البنكي', hours: 'مدة الانتظار', limit: 'الحد', title: 'العنوان', desc: 'الوصف', by: 'المُبلِّغ', severity: 'الخطورة', amount: 'المبلغ', handedBy: 'سلّمه', receivedBy: 'استلمه' },
    sec: { details: 'تفاصيل الطلب', calc: 'كيف حُسب المبلغ', carries: 'ما يتضمنه', stages: 'أين وصل الطلب', more: 'و{n} أخرى' },
    calc: { storeCash: 'مبيعات الفرع النقدية', carCash: 'مبيعات السيارات النقدية', posCash: 'مبيعات أجهزة نقاط البيع النقدية', otherCash: 'تحصيلات أخرى', creditFee: 'رسوم توصيل عملاء الآجل', chFee: 'رسوم توصيل قنوات البيع', over: 'زيادة في الاستلام', totalIn: 'إجمالي المحصَّل', delivery: 'رسوم توصيل مدفوعة للبنك (قبل الضريبة)', credit: 'مبيعات آجلة', creditFeeOff: 'رسوم توصيل الآجل، تُحصَّل لاحقاً', commission: 'عمولات العملاء', chCom: 'عمولات قنوات البيع', discount: 'الخصومات', transfer: 'تحويلات العملاء البنكية', expense: 'مصروفات مدفوعة', banked: 'الموازنات: مبيعات شبكة أجهزة POS المودعة مباشرة', short: 'نقص في الاستلام', totalOut: 'إجمالي الخصومات', diff: 'فرق غير مفسَّر', net: 'صافي النقدية' },
    stg: ['الإدخال', 'الفرع', 'المنطقة', 'تحقق العمليات', 'المحصّل', 'البنك'],
    sar: 'ريال', amountTo: 'للتسليم', amountGot: 'مُستلم',
    fallback: 'إن لم يفتح الزر، انسخ هذا الرابط في المتصفح:',
    why: 'وصلتك هذه الرسالة لأنك طرف في هذا الطلب في نظام تحصيل النقدية لدى الناقل الأفضل للغاز. أُرسلت تلقائياً ولا تُقرأ الردود عليها.',
    hi: 'مرحباً {name}،'
  },
  ur: {
    dir: 'rtl', org: 'بیسٹ گیس کیریئر کمپنی', app: 'کیش کلیکشن',
    tag: { action: 'آپ کی کارروائی درکار ہے', bad: 'توجہ درکار ہے', good: 'مکمل ہو گیا', info: 'حالت کی تازہ کاری', warn: 'انتباہ' },
    kind: { car_to_location: 'گاڑی سے برانچ کو حوالگی', location_to_cluster: 'برانچ سے علاقے کو حوالگی', cluster_to_collector: 'علاقے سے کلکٹر کو حوالگی', deposit: 'بینک ڈپازٹ', batch: 'علاقے کا اپ لوڈ' },
    st: { pending: 'وصولی کا انتظار', pending_deputy: 'آپریشنز کی جانچ کا انتظار', confirmed: 'وصول ہو گیا', disputed: 'اعتراض شدہ', returned: 'درستی کے لیے واپس', rejected: 'مسترد', completed: 'جمع ہو گیا', deputy_approved: 'منظور', approving: 'منظوری جاری', voided: 'منسوخ' },
    ev: {
      confirm_receipt: { s: 'وصولی کی تصدیق کریں: {from} سے {amount} ریال', h: 'نقدی آپ کی طرف آ رہی ہے', l: '{from} نے آپ کو {amount} ریال حوالے کیے ہیں۔ گن کر جو رقم واقعی ملی اس کی تصدیق کریں۔', b: 'وصولی کی تصدیق کریں', t: 'action' },
      deputy_validate: { s: 'جانچ درکار: {from} کی {amount} ریال کی حوالگی', h: 'ایک حوالگی آپ کی جانچ کی منتظر ہے', l: '{from} {amount} ریال {to} کو بھیج رہے ہیں۔ یہ آپ کی جانچ کے بعد ہی کلکٹر تک پہنچے گی۔', b: 'درخواست دیکھیں', t: 'action' },
      deputy_validate_rev: { s: 'درست شدہ حوالگی (ورژن {rev}) آپ کی جانچ کی منتظر', h: 'درست شدہ حوالگی دوبارہ جانچ کے لیے آئی ہے', l: '{from} نے واپس کی گئی حوالگی درست کر کے دوبارہ بھیجی: {amount} ریال {to} کو۔', b: 'درخواست دیکھیں', t: 'action' },
      returned: { s: 'درستی کے لیے واپس: آپ کی {amount} ریال کی حوالگی', h: 'آپ کی حوالگی واپس کر دی گئی', l: '{by} نے {to} کو {amount} ریال کی آپ کی حوالگی واپس کر دی۔ نقدی آپ کے پاس واپس ہے: درخواست درست کر کے دوبارہ بھیجیں۔', b: 'درست کر کے دوبارہ بھیجیں', t: 'bad' },
      confirmed: { s: 'مکمل وصول: آپ کی {amount} ریال کی حوالگی', h: 'آپ کی حوالگی وصول ہو گئی', l: '{to} نے پوری {amount} ریال کی وصولی کی تصدیق کر دی۔', b: 'درخواست دیکھیں', t: 'good' },
      confirmed_short: { s: 'کم وصول: آپ کی {declared} ریال کی حوالگی', h: 'آپ کی حوالگی کم وصول ہوئی', l: '{to} کو آپ کے اعلان کردہ {declared} ریال میں سے {amount} ریال ملے۔ فرق اس درخواست پر درج ہے۔', b: 'درخواست دیکھیں', t: 'bad' },
      confirmed_over: { s: 'زیادہ وصول: آپ کی {declared} ریال کی حوالگی', h: 'آپ کی حوالگی زیادہ وصول ہوئی', l: '{to} کو {amount} ریال ملے جبکہ آپ نے {declared} ریال کا اعلان کیا تھا۔ فرق اس درخواست پر درج ہے۔', b: 'درخواست دیکھیں', t: 'warn' },
      validated: { s: 'جانچ مکمل: آپ کی {amount} ریال کی حوالگی آگے بھیج دی گئی', h: 'آپ کی حوالگی آپریشنز کی جانچ سے گزر گئی', l: '{by} نے آپ کی {amount} ریال کی حوالگی جانچ کر {to} کو وصولی کے لیے بھیج دی۔', b: 'درخواست دیکھیں', t: 'good' },
      disputed: { s: 'اعتراض: {from} کی {amount} ریال کی حوالگی', h: 'ایک حوالگی پر اعتراض ہوا', l: '{by} نے {from} سے {to} کو {amount} ریال کی حوالگی پر اعتراض کیا۔ فنانس یا ایڈمن کے فیصلے تک یہ رکی رہے گی۔', b: 'اعتراض دیکھیں', t: 'bad' },
      disputed_sender: { s: 'آپ کی {amount} ریال کی حوالگی پر اعتراض ہوا', h: 'آپ کی حوالگی پر اعتراض ہوا', l: '{by} نے {to} کو آپ کی {amount} ریال کی حوالگی پر اعتراض کیا۔ فنانس یا ایڈمن فیصلہ کریں گے۔', b: 'درخواست دیکھیں', t: 'bad' },
      resolved_confirm: { s: 'اعتراض طے: {amount} ریال کی حوالگی قبول', h: 'اعتراض طے ہو گیا', l: '{by} نے اعتراض طے کر کے {amount} ریال پر حوالگی قبول کر لی۔', b: 'درخواست دیکھیں', t: 'good' },
      resolved_reject: { s: 'اعتراض طے: {amount} ریال کی حوالگی مسترد', h: 'حوالگی مسترد ہو گئی', l: '{by} نے {amount} ریال کی حوالگی مسترد کر دی۔ نقدی دوبارہ حوالگی کے لیے {from} کے پاس واپس گئی۔', b: 'درخواست دیکھیں', t: 'bad' },
      shortfall: { s: 'کم وصولی: {no} میں {short} ریال کم', h: 'ایک حوالگی کم وصول ہوئی', l: '{to} کو {from} کے اعلان کردہ {declared} ریال میں سے {amount} ریال ملے۔', b: 'درخواست کھولیں', t: 'warn' },
      overage: { s: 'زیادہ وصولی: {no} میں {short} ریال زیادہ', h: 'ایک حوالگی زیادہ وصول ہوئی', l: '{to} کو {amount} ریال ملے جبکہ {from} نے {declared} ریال کا اعلان کیا تھا۔', b: 'درخواست کھولیں', t: 'warn' },
      large_info: { s: 'بڑی حوالگی وصول ہوئی: {amount} ریال', h: 'ایک بڑی حوالگی وصول ہوئی', l: '{to} کو {from} سے {amount} ریال ملے، جو {limit} ریال کی حد سے زیادہ ہے۔ فنانس یا ایڈمن دوسری منظوری دیں گے؛ آپ سے کچھ درکار نہیں۔', b: 'درخواست دیکھیں', t: 'info' },
      large: { s: 'دوسری منظوری درکار: {amount} ریال', h: 'بڑی حوالگی کو دوسری منظوری درکار ہے', l: '{to} کو {from} سے {amount} ریال ملے، جو {limit} ریال کی حد سے زیادہ ہے۔ رقم آگے جا چکی ہے؛ فنانس یا ایڈمن کی دوسری منظوری ابھی باقی ہے۔', b: 'دوسری منظوری دیں', t: 'action' },
      stale: { s: '{hours} گھنٹے سے انتظار: {amount} ریال ابھی وصول نہیں', h: 'ایک حوالگی بہت دیر سے منتظر ہے', l: '{from} نے {hours} گھنٹے پہلے {to} کو {amount} ریال حوالے کیے اور ابھی تصدیق نہیں ہوئی۔', b: 'درخواست کھولیں', t: 'warn' },
      held: { s: '{hours} گھنٹے سے رکھی: {amount} ریال آگے نہیں بھیجے گئے', h: 'نقدی بہت دیر سے رکھی ہوئی ہے', l: '{to} کے پاس {amount} ریال {hours} گھنٹے سے ہیں اور اگلے مرحلے کو نہیں دیے گئے۔', b: 'درخواست کھولیں', t: 'warn' },
      batch_pending: { s: '{amount} ریال کا علاقائی اپ لوڈ آپ کی منظوری کا منتظر', h: 'ایک علاقائی اپ لوڈ آپ کی منظوری کا منتظر ہے', l: '{from} نے {place} کا دن اپ لوڈ کیا: حوالگی کے لیے {amount} ریال نقد۔', b: 'اپ لوڈ دیکھیں', t: 'action' },
      batch_rejected: { s: 'آپ کا {amount} ریال کا اپ لوڈ مسترد ہو گیا', h: 'آپ کا علاقائی اپ لوڈ مسترد ہو گیا', l: '{by} نے آپ کا {amount} ریال کا اپ لوڈ مسترد کر دیا۔ درست کر کے دوبارہ بھیجیں۔', b: 'اپ لوڈ درست کریں', t: 'bad' },
      batch_approved: { s: 'منظور: آپ کا {amount} ریال کا علاقائی اپ لوڈ', h: 'آپ کا علاقائی اپ لوڈ منظور ہو گیا', l: '{by} نے آپ کا {amount} ریال کا اپ لوڈ منظور کر دیا۔ اب یہ کلکٹرز کی طرف جا رہا ہے۔', b: 'اپ لوڈ دیکھیں', t: 'good' },
      risk: { s: 'انتہائی سنگین رپورٹ: {title}', h: 'ایک انتہائی سنگین رپورٹ درج ہوئی', l: '{by} نے ایک انتہائی سنگین رپورٹ درج کی۔ رسک رجسٹر میں دیکھیں۔', b: 'رجسٹر کھولیں', t: 'warn' }
    },
    f: { no: 'درخواست نمبر', kind: 'قسم', from: 'از', to: 'بنام', place: 'برانچ', area: 'علاقہ', city: 'شہر', created: 'تاریخ', status: 'موجودہ حالت', declared: 'اعلان کردہ', received: 'وصول شدہ', short: 'کمی', over: 'زیادتی', reason: 'وجہ', note: 'نوٹ', disputeNote: 'اعتراض کی وجہ', resolution: 'فیصلے کا نوٹ', correction: 'کیا درست کیا گیا', rev: 'ورژن', prev: 'پچھلا ورژن', ref: 'بینک حوالہ', hours: 'انتظار', limit: 'حد', title: 'عنوان', desc: 'تفصیل', by: 'رپورٹ کنندہ', severity: 'سنگینی', amount: 'رقم', handedBy: 'حوالے کرنے والا', receivedBy: 'وصول کرنے والا' },
    sec: { details: 'درخواست کی تفصیل', calc: 'رقم کا حساب', carries: 'اس میں شامل', stages: 'درخواست کہاں ہے', more: 'اور {n} مزید' },
    calc: { storeCash: 'برانچ کی نقد فروخت', carCash: 'گاڑیوں کی نقد فروخت', posCash: 'POS کی نقد فروخت', otherCash: 'دیگر وصولیاں', creditFee: 'ادھار گاہکوں کی ڈیلیوری فیس', chFee: 'سیلز چینلز کی ڈیلیوری فیس', over: 'زیادہ وصولی', totalIn: 'کل وصولی', delivery: 'بینک کو ادا شدہ ڈیلیوری فیس (ٹیکس سے پہلے)', credit: 'ادھار فروخت', creditFeeOff: 'ادھار ڈیلیوری فیس، بعد میں وصول', commission: 'گاہکوں کا کمیشن', chCom: 'سیلز چینلز کا کمیشن', discount: 'رعایتیں', transfer: 'گاہکوں کی بینک ٹرانسفر', expense: 'ادا شدہ اخراجات', banked: 'موازنات: POS مشینوں سے براہِ راست جمع', short: 'کم وصولی', totalOut: 'کل کٹوتیاں', diff: 'غیر واضح فرق', net: 'خالص نقدی' },
    stg: ['اندراج', 'برانچ', 'علاقہ', 'آپریشنز جانچ', 'کلکٹر', 'بینک'],
    sar: 'ریال', amountTo: 'حوالگی کے لیے', amountGot: 'وصول شدہ',
    fallback: 'اگر بٹن نہ کھلے تو یہ لنک براؤزر میں کاپی کریں:',
    why: 'آپ کو یہ پیغام اس لیے ملا کیونکہ آپ بیسٹ گیس کیش کلیکشن میں اس درخواست کا حصہ ہیں۔ یہ خودکار طور پر بھیجا گیا؛ جوابات پڑھے نہیں جاتے۔',
    hi: 'السلام علیکم {name}،'
  }
};

function nmMoney_(n) {
  var v = Math.round(Math.abs(Number(n || 0)) * 100) / 100;
  var p = v.toFixed(2).split('.');
  return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + p[1];
}
function nmWhen_(iso) {
  if (!iso) return '';
  try { return Utilities.formatDate(new Date(iso), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm'); } catch (e) { return String(iso).slice(0, 16).replace('T', ' '); }
}
// one id map per sheet per request: a deposit escalated to eight people used to parse the sheets hundreds of times
function nmById_(sheet, id) {
  if (!id) return null;
  var ex = exec_(); ex.nmMaps = ex.nmMaps || {};
  var m = ex.nmMaps[sheet];
  if (!m) { m = Object.create(null); readSheet(sheet).forEach(function (r) { if (r && r.id) m[r.id] = r; }); ex.nmMaps[sheet] = m; }
  return m[id] || null;
}
function nmUser_(id) { return nmById_(SHEETS.USERS, id); }
function nmName_(id) { var u = nmUser_(id); return u ? u.name : ''; }
function nmRole_(id, lang) { var u = nmUser_(id); return u ? roleNameIn_(u.role, lang) : ''; }
// the branch, its area and city a handover belongs to
function nmPlace_(h) {
  var loc = nmById_(SHEETS.LOCATIONS, h.locationId);
  var cid = h.clusterId || (loc && loc.clusterId);
  var cl = nmById_(SHEETS.CLUSTERS, cid);
  return { branch: loc ? loc.name : '', area: cl ? cl.name : '', city: loc ? (loc.city || '') : '' };
}
// the link that opens this request in the app: ?open=<what>:<id>
function nmLink_(what, id) { return DEFAULT_APP_URL + '?open=' + encodeURIComponent(what + ':' + id); }

// The cash statement, the same parts and order as cashCalcRows_ in the client.
function nmCalc_(b, c) {
  b = b || {};
  function n(k) { return Number(b[k] || 0); }
  var ins = [], outs = [], short = n('shortfall');
  function add(list, key, v) { if (Math.abs(v) > 0.004) list.push([c.calc[key], v]); }
  add(ins, 'storeCash', n('storeCash')); add(ins, 'carCash', n('carCash')); add(ins, 'posCash', n('posCash'));
  add(ins, 'otherCash', n('otherCash')); add(ins, 'creditFee', n('creditDeliveryFees')); add(ins, 'chFee', n('channelDeliveryFees'));
  if (short < 0) add(ins, 'over', -short);
  add(outs, 'delivery', n('deliveryFee') - n('vatOnDelivery')); add(outs, 'credit', n('creditSales'));
  add(outs, 'creditFeeOff', n('creditDeliveryUnpaid')); add(outs, 'commission', n('creditCommissions')); add(outs, 'chCom', n('channelCommissions'));
  add(outs, 'discount', n('discounts')); add(outs, 'transfer', n('bankTransfers')); add(outs, 'expense', n('expenses'));
  add(outs, 'banked', n('directDeposit'));
  if (short > 0) add(outs, 'short', short);
  if (!ins.length && !outs.length) return null;
  function sum(l) { return l.reduce(function (a, r) { return a + r[1]; }, 0); }
  // what the parts leave unexplained, as brkParts_ shows it, so the statement always adds up
  var gap = Math.round((sum(ins) - sum(outs) - n('netCashOwed')) * 100) / 100;
  if (gap > 0.004) outs.push([c.calc.diff, gap]); else if (gap < -0.004) ins.push([c.calc.diff, -gap]);
  return { ins: ins, totalIn: sum(ins), outs: outs, totalOut: sum(outs), net: n('netCashOwed') };
}

// Which step of the chain a handover stands at: [index, done]
function nmStage_(h) {
  var at = { car_to_location: 1, location_to_cluster: 2, cluster_to_collector: h.status === 'pending_deputy' || h.status === 'returned' ? 3 : 4, deposit: 5, batch: 3 }[h.kind] || 1;
  var done = h.status === 'confirmed' || h.status === 'completed' || h.status === 'deputy_approved';
  if (h.kind === 'deposit') done = !!h.reconciled;
  return { at: at, done: done, bad: h.status === 'returned' || h.status === 'disputed' || h.status === 'rejected' };
}

// What a handover carries: its transactions (rows of one number merged) or the handovers under it.
function nmCarries_(h, c) {
  var rows = [];
  if (Array.isArray(h.sourceEntryIds) && h.sourceEntryIds.length) {
    var groups = {}, order = [];
    h.sourceEntryIds.forEach(function (id) {
      var e = nmById_(SHEETS.ENTRIES, id);
      if (!e || e.voided) return;
      var k = e.txNo || e.submissionId || e.id;
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(e);
    });
    order.forEach(function (k) {
      var g = groups[k], e0 = g[0], loc = nmById_(SHEETS.LOCATIONS, e0.locationId);
      rows.push([e0.txNo || '', e0.date || '', loc ? loc.name : '', computeNet_(g).netCashOwed]);
    });
  }
  (Array.isArray(h.sourceHandoffIds) ? h.sourceHandoffIds : []).forEach(function (id) {
    var s = nmById_(SHEETS.HANDOFFS, id); if (!s) return;
    var p = nmPlace_(s);
    rows.push([s.txNo || '', String(s.confirmedAt || s.createdAt || '').slice(0, 10), p.branch || nmName_(s.fromUserId), Number(s.amount || 0)]);
  });
  return rows;
}

// One handover email. ev: a key of NM_[lang].ev; x: { by, reason, hours, limit, open }
function nmHandoffMail_(u, ev, h, x) { try { nmHandoffMailIn_(u, ev, h, x); } catch (e) { console.error('mail ' + ev + ': ' + e); } }
function nmBatchMail_(u, ev, b, x) { try { nmBatchMailIn_(u, ev, b, x); } catch (e) { console.error('mail ' + ev + ': ' + e); } }
function nmRiskMail_(u, item, reporter) { try { nmRiskMailIn_(u, item, reporter); } catch (e) { console.error('mail risk: ' + e); } }
// A person who is not a party to the handover and has no company-wide view gets the alert without its
// statement and transactions: those are what the app itself does not show them.
var NM_FULL_ROLES_ = ['admin', 'finance', 'accountant', 'operations_manager', 'deputy_operations_manager'];
function nmHandoffMailIn_(u, ev, h, x) {
  if (!u || !u.email || !h || u.active === false) return;
  x = x || {};
  var lang = userLang_(u), c = NM_[lang] || NM_.en, E = c.ev[ev]; if (!E) return;
  var p = nmPlace_(h), declared = h.originalAmount != null ? Number(h.originalAmount) : Number(h.amount);
  var toName = h.toUserId ? nmName_(h.toUserId) : (lang === 'en' ? 'the bank' : lang === 'ur' ? 'بینک' : 'البنك');
  var vars = { amount: nmMoney_(h.amount), declared: nmMoney_(declared), short: nmMoney_(h.shortfall), from: nmName_(h.fromUserId), to: toName,
    by: x.by ? nmName_(x.by) : '', no: h.txNo || '', rev: h.revision || '', hours: x.hours != null ? Math.round(x.hours) : '', limit: x.limit != null ? nmMoney_(x.limit) : '' };
  var facts = [[c.f.no, h.txNo || String(h.id).slice(0, 8), true], [c.f.kind, c.kind[h.kind] || h.kind],
    [c.f.place, p.branch], [c.f.area, p.area], [c.f.city, p.city], [c.f.created, nmWhen_(h.createdAt), true], [c.f.status, c.st[h.status] || h.status]];
  if (h.revision > 1) facts.push([c.f.rev, String(h.revision), true]);
  if (h.bankReference) facts.push([c.f.ref, h.bankReference, true]);
  if (x.hours != null) facts.push([c.f.hours, Math.round(x.hours) + ' h', true]);
  var chips = [];
  if (h.originalAmount != null && Math.abs(Number(h.shortfall || 0)) > 0.004) {
    chips.push([c.f.declared, nmMoney_(declared), 'info'], [c.f.received, nmMoney_(h.amount), 'good'],
      [Number(h.shortfall) > 0 ? c.f.short : c.f.over, nmMoney_(h.shortfall), Number(h.shortfall) > 0 ? 'bad' : 'warn']);
  }
  var notes = [];
  if (x.reason) notes.push([c.f.reason, x.reason, 'bad']);
  if (ev.indexOf('disputed') === 0 && h.disputeNote) notes.push([c.f.disputeNote, h.disputeNote, 'bad']);
  if (ev.indexOf('resolved') === 0 && h.resolutionNote) notes.push([c.f.resolution, h.resolutionNote, 'info']);
  if (ev === 'deputy_validate_rev') {
    var was = (h.history || [])[(h.history || []).length - 1] || {};
    if (was.returnReason) notes.push([c.f.reason, was.returnReason, 'bad']);
    if (h.correctionNote) notes.push([c.f.correction, h.correctionNote, 'info']);
    if (was.amount != null) facts.push([c.f.prev, nmMoney_(was.amount) + ' ' + c.sar, true]);
  }
  if (ev === 'validated' && h.deputyNote) notes.push([c.f.note, h.deputyNote, 'info']);
  var full = u.id === h.fromUserId || u.id === h.toUserId || u.id === h.createdBy || NM_FULL_ROLES_.indexOf(u.role) >= 0;
  var carries = full ? nmCarries_(h, c) : [];
  var st = nmStage_(h);
  var got = h.status === 'confirmed' || h.status === 'completed';
  var link = nmLink_(x.open || 'view', h.id);
  nmSend_(u, c, lang, {
    subject: fill_(E.s, vars), tone: E.t, head: E.h, lead: fill_(E.l, vars), name: firstName_(u.name),
    amount: Number(h.amount), amountNote: got ? c.amountGot : c.amountTo, chips: chips,
    route: { from: nmName_(h.fromUserId), fromRole: nmRole_(h.fromUserId, lang), to: toName, toRole: h.toUserId ? nmRole_(h.toUserId, lang) : '' },
    facts: facts, notes: notes, calc: full ? nmCalc_(h.breakdown, c) : null, carries: carries, stages: st, button: E.b, link: link
  });
}

function nmBatchMailIn_(u, ev, batch, x) {
  if (!u || !u.email || !batch || u.active === false) return;
  x = x || {};
  var lang = userLang_(u), c = NM_[lang] || NM_.en, E = c.ev[ev]; if (!E) return;
  var cl = batch.clusterId ? getById_(SHEETS.CLUSTERS, batch.clusterId) : null;
  var net = Number((batch.breakdown || {}).netCashOwed || 0);
  var vars = { amount: nmMoney_(net), from: nmName_(batch.uploadedBy), by: x.by ? nmName_(x.by) : '', place: cl ? cl.name : '' };
  var facts = [[c.f.kind, c.kind.batch], [c.f.area, cl ? cl.name : ''], [c.f.created, nmWhen_(batch.createdAt), true], [c.f.status, c.st[batch.status] || batch.status]];
  if (batch.revision > 1) facts.push([c.f.rev, String(batch.revision), true]);
  var notes = [];
  if (batch.rejectionNote && ev === 'batch_rejected') notes.push([c.f.reason, batch.rejectionNote, 'bad']);
  var carries = (batch.perLocation || []).map(function (pl) {
    var loc = getById_(SHEETS.LOCATIONS, pl.locationId);
    return ['', '', loc ? loc.name : '', Number((pl.breakdown || pl).netCashOwed || pl.amount || 0)];
  });
  nmSend_(u, c, lang, {
    subject: fill_(E.s, vars), tone: E.t, head: E.h, lead: fill_(E.l, vars), name: firstName_(u.name),
    amount: net, amountNote: c.amountTo, chips: [],
    route: { from: nmName_(batch.uploadedBy), fromRole: nmRole_(batch.uploadedBy, lang), to: cl ? cl.name : '', toRole: '' },
    facts: facts, notes: notes, calc: nmCalc_(batch.breakdown, c), carries: carries,
    stages: { at: 3, done: batch.status === 'deputy_approved', bad: batch.status === 'rejected' }, button: E.b, link: nmLink_(x.open || 'batch', batch.id)
  });
}

function nmRiskMailIn_(u, item, reporter) {
  if (!u || !u.email || u.active === false) return;
  var lang = userLang_(u), c = NM_[lang] || NM_.en, E = c.ev.risk;
  var vars = { title: item.title || '', by: reporter ? reporter.name || '' : '' };
  nmSend_(u, c, lang, {
    subject: fill_(E.s, vars), tone: E.t, head: E.h, lead: fill_(E.l, vars), name: firstName_(u.name),
    facts: [[c.f.title, item.title || ''], [c.f.by, vars.by], [c.f.created, nmWhen_(item.createdAt || new Date().toISOString()), true]],
    notes: [[c.f.desc, item.description || '', 'bad']], button: E.b, link: nmLink_('risk_high', item.id || '')
  });
}

// Builds and sends: the HTML and its plain-text twin.
function nmSend_(u, c, lang, o) {
  try { sendMail_(u.email, o.subject, nmText_(c, o), nmHtml_(c, lang, o)); } catch (e) { /* email is best-effort */ }
}

function nmText_(c, o) {
  var L = [fill_(c.hi, { name: o.name }), '', o.head, o.lead, ''];
  if (o.amount != null) L.push(c.f.amount + ': ' + nmMoney_(o.amount) + ' ' + c.sar, '');
  if (o.route && o.route.from) L.push(c.f.from + ': ' + o.route.from + '  ›  ' + c.f.to + ': ' + o.route.to);
  (o.facts || []).forEach(function (f) { if (f[1]) L.push(f[0] + ': ' + f[1]); });
  (o.notes || []).forEach(function (n) { L.push('', n[0] + ': ' + n[1]); });
  if (o.calc) {
    L.push('', c.sec.calc);
    o.calc.ins.forEach(function (r) { L.push('  + ' + r[0] + ': ' + nmMoney_(r[1])); });
    L.push('  = ' + c.calc.totalIn + ': ' + nmMoney_(o.calc.totalIn));
    o.calc.outs.forEach(function (r) { L.push('  - ' + r[0] + ': ' + nmMoney_(r[1])); });
    if (o.calc.outs.length) L.push('  = ' + c.calc.totalOut + ': ' + nmMoney_(o.calc.totalOut));
    L.push('  ' + c.calc.net + ': ' + nmMoney_(o.calc.net));
  }
  L.push('', o.button + ': ' + o.link, '', c.why);
  return L.join('\n');
}

function nmHtml_(c, lang, o) {
  var e = htmlEsc_, rtl = c.dir === 'rtl', A = rtl ? 'right' : 'left', B = rtl ? 'left' : 'right', D = ' dir="' + c.dir + '"';
  var FONT = rtl ? "Tahoma,'Segoe UI',Arial,sans-serif" : "'Segoe UI',Helvetica,Arial,sans-serif";
  var NUM = "'Segoe UI',Tahoma,Arial,sans-serif";
  var G = '#4D6D51', DEEP = '#23372A', CREAM = '#F2EEE4', PAPER = '#FBF9F4', INK = '#1B231D', BODY = '#3F4A42', MUTED = '#66716A', LINE = '#E6E1D4';
  var TONE = { action: ['#9A5B00', '#FDF1DC', '#E9B45A'], bad: ['#A3322A', '#FBE7E4', '#E59A91'], good: ['#2F6B3F', '#E4F0E6', '#8DBE98'], warn: ['#8A5A00', '#FCF3DE', '#E3C27A'], info: [G, '#ECEFE7', '#B8C7B4'] };
  var T = TONE[o.tone] || TONE.info, L = e(o.link), logo = e(DEFAULT_APP_URL + 'assets/mail-logo.png');
  function sp(h) { return '<tr><td style="height:' + h + 'px;line-height:' + h + 'px;font-size:1px;">&nbsp;</td></tr>'; }
  function money(v, size, color) { return '<span dir="ltr" style="font-family:' + NUM + ';font-size:' + size + 'px;font-weight:bold;color:' + color + ';white-space:nowrap;">' + e(nmMoney_(v)) + '</span>'; }
  function secHead(t) { return '<div' + D + ' style="font-family:' + FONT + ';font-size:13px;font-weight:bold;color:' + G + ';text-align:' + A + ';padding:0 0 10px;">' + e(t) + '</div>'; }
  function button(label) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">' +
      '<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="' + L + '" style="height:54px;v-text-anchor:middle;width:340px;" arcsize="26%" stroke="f" fillcolor="' + G + '"><w:anchorlock/><center style="color:#ffffff;font-family:Tahoma,Arial,sans-serif;font-size:17px;font-weight:bold;">' + e(label) + '</center></v:roundrect><![endif]-->' +
      '<!--[if !mso]><!-- --><a href="' + L + '" target="_blank" style="display:block;max-width:380px;margin:0 auto;background:' + G + ';color:#ffffff;font-family:' + FONT + ';font-size:17px;font-weight:bold;line-height:56px;text-align:center;text-decoration:none;border-radius:14px;">' + e(label) + '</a><!--<![endif]-->' +
      '</td></tr></table>';
  }
  var out = [];
  out.push('<!DOCTYPE html><html lang="' + lang + '"' + D + ' xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    '<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->' +
    '<title>' + e(o.subject) + '</title></head><body style="margin:0;padding:0;background:' + CREAM + ';">' +
    '<div style="display:none;max-height:0;overflow:hidden;">' + e(o.lead) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + CREAM + '" style="background:' + CREAM + ';"><tr><td align="center" style="padding:22px 10px 30px;">' +
    '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">');

  // the company band: logo, name, the system
  out.push('<tr><td bgcolor="' + DEEP + '" style="background:' + DEEP + ';border-radius:22px 22px 0 0;padding:20px 24px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"' + D + '><tr>' +
    '<td width="62" valign="middle" style="width:62px;"><img src="' + logo + '" width="54" height="54" alt="Best Gas" style="display:block;border:0;border-radius:14px;"></td>' +
    '<td valign="middle"' + D + ' style="padding-' + (rtl ? 'right' : 'left') + ':12px;text-align:' + A + ';font-family:' + FONT + ';">' +
      '<div style="color:#ffffff;font-size:16px;font-weight:bold;line-height:1.3;">' + e(c.org) + '</div>' +
      '<div style="color:#C9D6C6;font-size:12.5px;line-height:1.5;">' + e(c.app) + '</div></td>' +
    '<td valign="middle" align="' + B + '" style="text-align:' + B + ';"><span style="display:inline-block;background:' + T[1] + ';color:' + T[0] + ';font-family:' + FONT + ';font-size:12px;font-weight:bold;line-height:1;padding:8px 12px;border-radius:999px;white-space:nowrap;">' + e(c.tag[o.tone] || c.tag.info) + '</span></td>' +
    '</tr></table></td></tr>');

  // the card
  out.push('<tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 22px 22px;padding:0;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">');
  // a strip in the tone's colour, then what happened
  out.push('<tr><td style="height:5px;line-height:5px;font-size:1px;background:' + T[2] + ';">&nbsp;</td></tr>');
  out.push('<tr><td' + D + ' style="padding:26px 26px 0;text-align:' + A + ';font-family:' + FONT + ';">' +
    '<div style="font-size:14px;color:' + MUTED + ';">' + e(fill_(c.hi, { name: o.name })) + '</div>' +
    '<div style="font-size:24px;line-height:1.35;font-weight:bold;color:' + INK + ';margin-top:6px;">' + e(o.head) + '</div>' +
    '<div style="font-size:15.5px;line-height:1.8;color:' + BODY + ';margin-top:8px;">' + e(o.lead) + '</div></td></tr>');

  // the slip: the amount, and who hands it to whom
  if (o.amount != null) {
    var slip = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + DEEP + '" style="background:' + DEEP + ';border-radius:18px;">' +
      '<tr><td align="center" style="padding:22px 18px 16px;font-family:' + FONT + ';">' +
        '<div style="color:#C9D6C6;font-size:12.5px;">' + e(c.f.amount) + ' · ' + e(o.amountNote || '') + '</div>' +
        '<div style="margin-top:4px;line-height:1.1;">' + money(o.amount, 38, '#ffffff') + ' <span style="font-family:' + FONT + ';font-size:15px;color:#E8D9A8;font-weight:bold;">' + e(c.sar) + '</span></div>' +
      '</td></tr>';
    if (o.route && (o.route.from || o.route.to)) {
      slip += '<tr><td style="padding:0 18px;"><div style="border-top:2px dashed #4E6A55;height:0;line-height:0;font-size:0;">&nbsp;</div></td></tr>' +
        '<tr><td style="padding:14px 18px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"' + D + '><tr>' +
        '<td width="44%" valign="top"' + D + ' style="text-align:' + A + ';font-family:' + FONT + ';"><div style="color:#9FB59E;font-size:11.5px;">' + e(c.f.from) + '</div><div style="color:#ffffff;font-size:15px;font-weight:bold;line-height:1.35;">' + e(o.route.from) + '</div>' + (o.route.fromRole ? '<div style="color:#C9D6C6;font-size:12px;">' + e(o.route.fromRole) + '</div>' : '') + '</td>' +
        '<td width="12%" align="center" valign="middle" style="color:#E8D9A8;font-family:Arial,sans-serif;font-size:22px;font-weight:bold;">' + (rtl ? '&#8592;' : '&#8594;') + '</td>' +
        '<td width="44%" valign="top"' + D + ' style="text-align:' + B + ';font-family:' + FONT + ';"><div style="color:#9FB59E;font-size:11.5px;">' + e(c.f.to) + '</div><div style="color:#ffffff;font-size:15px;font-weight:bold;line-height:1.35;">' + e(o.route.to) + '</div>' + (o.route.toRole ? '<div style="color:#C9D6C6;font-size:12px;">' + e(o.route.toRole) + '</div>' : '') + '</td>' +
        '</tr></table></td></tr>';
    }
    slip += '</table>';
    out.push('<tr><td style="padding:20px 26px 0;">' + slip + '</td></tr>');
  }
  // declared / received / short
  if (o.chips && o.chips.length) {
    out.push('<tr><td style="padding:12px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"' + D + '><tr>' +
      o.chips.map(function (ch, i) { var t = TONE[ch[2]] || TONE.info; return '<td width="33%" valign="top" style="padding:' + (i ? '0 0 0 0' : '0') + ';"><div style="margin:0 3px;background:' + t[1] + ';border-radius:12px;padding:10px 8px;text-align:center;font-family:' + FONT + ';"><div style="font-size:11.5px;color:' + t[0] + ';">' + e(ch[0]) + '</div><div style="margin-top:2px;">' + money(ch[1].replace(/,/g, ''), 16, t[0]) + '</div></div></td>'; }).join('') +
      '</tr></table></td></tr>');
  }
  // reasons and notes, where the eye lands next
  (o.notes || []).forEach(function (n) {
    if (!n[1]) return;
    var t = TONE[n[2]] || TONE.info;
    out.push('<tr><td style="padding:14px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td' + D + ' style="background:' + t[1] + ';border-' + (rtl ? 'right' : 'left') + ':4px solid ' + t[2] + ';border-radius:10px;padding:12px 14px;text-align:' + A + ';font-family:' + FONT + ';">' +
      '<div style="font-size:12px;font-weight:bold;color:' + t[0] + ';">' + e(n[0]) + '</div>' +
      '<div dir="auto" style="font-size:14.5px;line-height:1.7;color:' + INK + ';margin-top:2px;white-space:pre-wrap;">' + e(n[1]) + '</div></td></tr></table></td></tr>');
  });
  // the one action
  out.push('<tr><td style="padding:22px 26px 0;">' + button(o.button) + '</td></tr>');

  // the request's details
  var facts = (o.facts || []).filter(function (f) { return f[1] !== '' && f[1] != null; });
  if (facts.length) {
    out.push('<tr><td style="padding:26px 26px 0;">' + secHead(c.sec.details) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + PAPER + '" style="background:' + PAPER + ';border:1px solid ' + LINE + ';border-radius:14px;">' +
      facts.map(function (f, i) {
        return '<tr><td' + D + ' style="padding:10px 14px;' + (i ? 'border-top:1px solid ' + LINE + ';' : '') + 'font-family:' + FONT + ';font-size:13px;color:' + MUTED + ';text-align:' + A + ';">' + e(f[0]) + '</td>' +
          '<td' + D + ' style="padding:10px 14px;' + (i ? 'border-top:1px solid ' + LINE + ';' : '') + 'font-family:' + FONT + ';font-size:14px;font-weight:bold;color:' + INK + ';text-align:' + B + ';">' + (f[2] ? '<span dir="ltr">' + e(f[1]) + '</span>' : e(f[1])) + '</td></tr>';
      }).join('') + '</table></td></tr>');
  }

  // how the amount is worked out: collected, deductions, net
  if (o.calc) {
    var k = o.calc;
    function line(label, v, sign, strong, color) {
      return '<tr><td' + D + ' style="padding:7px 14px;font-family:' + FONT + ';font-size:' + (strong ? 14 : 13.5) + 'px;' + (strong ? 'font-weight:bold;' : '') + 'color:' + (strong ? INK : BODY) + ';text-align:' + A + ';">' + e(label) + '</td>' +
        '<td style="padding:7px 14px;text-align:' + B + ';white-space:nowrap;">' + (sign ? '<span style="font-family:Arial,sans-serif;font-size:13px;color:' + MUTED + ';">' + sign + '</span>&nbsp;' : '') + money(v, strong ? 14.5 : 13.5, color || INK) + '</td></tr>';
    }
    var calc = k.ins.map(function (r) { return line(r[0], r[1], '+', false); }).join('') +
      '<tr><td colspan="2" style="padding:0 14px;"><div style="border-top:1px solid ' + LINE + ';height:0;font-size:0;line-height:0;">&nbsp;</div></td></tr>' +
      line(c.calc.totalIn, k.totalIn, '', true);
    if (k.outs.length) calc += k.outs.map(function (r) { return line(r[0], r[1], '−', false, '#A3322A'); }).join('') +
      '<tr><td colspan="2" style="padding:0 14px;"><div style="border-top:1px solid ' + LINE + ';height:0;font-size:0;line-height:0;">&nbsp;</div></td></tr>' +
      line(c.calc.totalOut, k.totalOut, '−', true, '#A3322A');
    calc += '<tr><td' + D + ' bgcolor="' + G + '" style="background:' + G + ';padding:12px 14px;border-radius:' + (rtl ? '0 0 13px 0' : '0 0 0 13px') + ';font-family:' + FONT + ';font-size:15px;font-weight:bold;color:#ffffff;text-align:' + A + ';">' + e(c.calc.net) + '</td>' +
      '<td bgcolor="' + G + '" style="background:' + G + ';padding:12px 14px;border-radius:' + (rtl ? '0 0 0 13px' : '0 0 13px 0') + ';text-align:' + B + ';">' + money(k.net, 17, '#ffffff') + '</td></tr>';
    out.push('<tr><td style="padding:24px 26px 0;">' + secHead(c.sec.calc) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ' + LINE + ';border-radius:14px;">' + sp(6) + calc + '</table></td></tr>');
  }

  // what it carries
  if (o.carries && o.carries.length) {
    var max = 8, shown = o.carries.slice(0, max);
    out.push('<tr><td style="padding:24px 26px 0;">' + secHead(c.sec.carries + ' (' + o.carries.length + ')') +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ' + LINE + ';border-radius:14px;">' +
      shown.map(function (r, i) {
        return '<tr><td' + D + ' style="padding:10px 14px;' + (i ? 'border-top:1px solid ' + LINE + ';' : '') + 'text-align:' + A + ';font-family:' + FONT + ';">' +
          '<div style="font-size:14px;font-weight:bold;color:' + INK + ';">' + e(r[2] || r[0]) + '</div>' +
          '<div style="font-size:12px;color:' + MUTED + ';"><span dir="ltr">' + e([r[0], r[1]].filter(Boolean).join('  ·  ')) + '</span></div></td>' +
          '<td style="padding:10px 14px;' + (i ? 'border-top:1px solid ' + LINE + ';' : '') + 'text-align:' + B + ';">' + money(r[3], 14, INK) + '</td></tr>';
      }).join('') +
      (o.carries.length > max ? '<tr><td colspan="2"' + D + ' style="padding:9px 14px;border-top:1px solid ' + LINE + ';font-family:' + FONT + ';font-size:12.5px;color:' + MUTED + ';text-align:' + A + ';">' + e(fill_(c.sec.more, { n: o.carries.length - max })) + '</td></tr>' : '') +
      '</table></td></tr>');
  }

  // where it stands: the chain, step by step
  if (o.stages) {
    var s = o.stages;
    out.push('<tr><td style="padding:24px 26px 0;">' + secHead(c.sec.stages) +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"' + D + '><tr>' +
      c.stg.map(function (label, i) {
        var done = i < s.at || (i === s.at && s.done), now = i === s.at && !s.done;
        var fill = done ? G : now ? (s.bad ? '#A3322A' : '#C98A1B') : '#ffffff', ring = done ? G : now ? fill : '#C9C3B4';
        var bar = i < c.stg.length - 1 ? (i < s.at ? G : LINE) : 'transparent';
        return '<td width="16%" valign="top" align="center" style="padding:0 1px;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
          '<td width="50%" style="font-size:0;line-height:0;"><div style="height:3px;background:' + (i ? (i <= s.at ? G : LINE) : 'transparent') + ';">&nbsp;</div></td>' +
          '<td style="font-size:0;line-height:0;"><div style="width:16px;height:16px;border-radius:8px;background:' + fill + ';border:3px solid ' + ring + ';margin:0 auto;">&nbsp;</div></td>' +
          '<td width="50%" style="font-size:0;line-height:0;"><div style="height:3px;background:' + bar + ';">&nbsp;</div></td></tr></table>' +
          '<div style="font-family:' + FONT + ';font-size:11px;line-height:1.35;margin-top:6px;color:' + (now ? INK : done ? BODY : MUTED) + ';' + (now ? 'font-weight:bold;' : '') + '">' + e(label) + '</div></td>';
      }).join('') + '</tr></table></td></tr>');
  }

  // the link written out, and why this came
  out.push('<tr><td' + D + ' style="padding:24px 26px 0;font-family:' + FONT + ';font-size:12px;line-height:1.7;color:' + MUTED + ';text-align:' + A + ';">' + e(c.fallback) +
    '<div dir="ltr" style="margin-top:3px;font-family:Arial,sans-serif;font-size:11.5px;word-break:break-all;text-align:left;"><a href="' + L + '" style="color:' + G + ';">' + L + '</a></div></td></tr>');
  out.push('<tr><td' + D + ' style="padding:18px 26px 22px;font-family:' + FONT + ';font-size:12px;line-height:1.8;color:' + MUTED + ';text-align:' + A + ';"><div style="border-top:1px solid ' + LINE + ';padding-top:14px;">' + e(c.why) + '</div></td></tr>');
  out.push('</table></td></tr>');
  out.push('<tr><td align="center" style="padding:14px 10px 0;font-family:' + FONT + ';font-size:11.5px;color:' + MUTED + ';">' + e(c.org) + ' · ' + e(c.app) + '</td></tr>');
  out.push('</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>');
  return out.join('');
}
