// Daily segmentation script for the Free Member Upsell CRM.
// Reads non-purchaser Members rows, groups by Health Bucket,
// writes dated tabs + First Message back to col Q, prunes old tabs.
//
// Setup:
//   1. Run createDailyTrigger() once to install the 7am time-driven trigger.
//   2. The onEdit() function fires automatically on every sheet edit — no setup needed.
//      When you mark Sent = Y on a segmentation tab, it writes "{Bucket} DM" to col Q
//      in Members for that person.

var MEMBERS_SHEET = 'Members';
var SYNC_LOG_SHEET = 'Sync Log';
var BUCKETS = ['Red', 'Yellow', 'Green'];
var ACTIVATION_STEP_HEADERS = [
  'Roadmap',
  'Target Role',
  'Resume',
  'LinkedIn',
  'Community',
  'DM/Email Response',
];

// Col indices in the segmentation tabs (0-based)
var SEG_COL = { NAME: 0, EMAIL: 1, MAIN_GOAL: 2, BUCKET: 3, ACT_SCORE: 4, MESSAGE: 5, SENT: 6 };

// Starter message templates — customise text here.
var TEMPLATES = {
  Green: function (name, mainGoal) {
    return (
      'Hey ' +
      name +
      ' — looks like you’re making great progress. Wanted to share how the full program could accelerate your ' +
      (mainGoal || 'career') +
      ' search…'
    );
  },
  Yellow: function (name, missingSteps) {
    var step = missingSteps.length > 0 ? missingSteps[0] : 'next steps';
    return 'Hey ' + name + ' — just checking in. Have you had a chance to finish ' + step + '?';
  },
  Red: function (name) {
    return (
      'Hey ' +
      name +
      ' — wanted to make sure you found everything okay in Week 1. What’s been the biggest blocker?'
    );
  },
};

// ---------------------------------------------------------------------------
// Main daily job
// ---------------------------------------------------------------------------

function runDailySegmentation() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var membersSheet = ss.getSheetByName(MEMBERS_SHEET);
  if (!membersSheet) {
    Logger.log('ERROR: Members sheet not found');
    return;
  }

  var today = new Date();
  var tz = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(today, tz, 'yyyyMMdd');

  var allData = membersSheet.getDataRange().getValues();
  if (allData.length < 2) {
    Logger.log('No data rows found');
    return;
  }

  var headers = allData[0];
  var colIdx = {};
  headers.forEach(function (h, i) {
    colIdx[String(h).trim()] = i;
  });

  var required = [
    'Name',
    'Email',
    'Main Goal',
    'Health Bucket',
    'Activation Score',
    'Purchase/Scholarship',
  ];
  var missing = required.filter(function (h) {
    return colIdx[h] === undefined;
  });
  if (missing.length > 0) {
    Logger.log('ERROR: Missing columns: ' + missing.join(', '));
    _appendSyncLog(ss, 'runDailySegmentation', 'error', 'Missing columns: ' + missing.join(', '));
    return;
  }

  var groups = { Red: [], Yellow: [], Green: [] };

  for (var i = 1; i < allData.length; i++) {
    var row = allData[i];
    var existing = String(row[colIdx['First Message']] || '').trim();

    var purchase = String(row[colIdx['Purchase/Scholarship']] || '')
      .trim()
      .toUpperCase();
    if (purchase === 'Y') continue;

    var bucket = String(row[colIdx['Health Bucket']] || '').trim();
    if (!groups[bucket]) continue;

    // Skip members who already have a First Message status
    if (existing) continue;

    var name = String(row[colIdx['Name']] || '').trim();
    var email = String(row[colIdx['Email']] || '').trim();
    var mainGoal = String(row[colIdx['Main Goal']] || '').trim();
    var actScore = row[colIdx['Activation Score']];

    var missingSteps = ACTIVATION_STEP_HEADERS.filter(function (step) {
      var ci = colIdx[step];
      if (ci === undefined) return false;
      return String(row[ci] || '').trim().toUpperCase() !== 'Y';
    });

    var message = TEMPLATES[bucket](name, bucket === 'Green' ? mainGoal : missingSteps);

    groups[bucket].push([name, email, mainGoal, bucket, actScore, message, '']);
  }

  // Write segmentation tabs
  BUCKETS.forEach(function (bucket) {
    var tabName = bucket + '_' + dateStr;
    var old = ss.getSheetByName(tabName);
    if (old) ss.deleteSheet(old);

    var tab = ss.insertSheet(tabName);
    tab.appendRow(['Name', 'Email', 'Main Goal', 'Health Bucket', 'Activation Score', 'First Message', 'Sent']);

    var rows = groups[bucket];
    if (rows.length > 0) {
      tab.getRange(2, 1, rows.length, 7).setValues(rows);
    }

    // Add dropdown validation on Sent column so it's easy to mark Y
    if (rows.length > 0) {
      var sentRule = SpreadsheetApp.newDataValidation()
        .requireValueInList(['Y', 'N'], true)
        .build();
      tab.getRange(2, SEG_COL.SENT + 1, rows.length, 1).setDataValidation(sentRule);
    }

    Logger.log(bucket + ': ' + rows.length + ' member(s) → ' + tabName);
  });

  // Prune segmentation tabs older than 7 days
  var cutoffMs = today.getTime() - 7 * 24 * 60 * 60 * 1000;
  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    var match = name.match(/^(Red|Yellow|Green)_(\d{8})$/);
    if (!match) return;
    var tabDate = Utilities.parseDate(match[2], tz, 'yyyyMMdd');
    if (tabDate.getTime() < cutoffMs) {
      ss.deleteSheet(sheet);
      Logger.log('Pruned old tab: ' + name);
    }
  });

  var summary =
    'Red:' + groups.Red.length + ' Yellow:' + groups.Yellow.length + ' Green:' + groups.Green.length;
  Logger.log('Done — ' + summary);
  _appendSyncLog(ss, 'runDailySegmentation', 'success', summary);
}

// ---------------------------------------------------------------------------
// onEdit trigger — fires on every edit in the spreadsheet.
// When Sent = Y is set on a segmentation tab, writes "{Bucket} DM" to
// col Q (First Message) in Members for the matching email.
// ---------------------------------------------------------------------------

function onEdit(e) {
  var range = e.range;
  var sheet = range.getSheet();
  var sheetName = sheet.getName();

  // Only act on segmentation tabs
  var match = sheetName.match(/^(Red|Yellow|Green)_(\d{8})$/);
  if (!match) return;

  // Only act on the Sent column (col 7, 1-based)
  if (range.getColumn() !== SEG_COL.SENT + 1) return;
  if (range.getNumRows() !== 1) return; // ignore multi-row pastes

  var value = String(e.value || '').trim().toUpperCase();
  if (value !== 'Y') return;

  var bucket = match[1]; // Red, Yellow, or Green
  var row = range.getRow();
  if (row < 2) return; // skip header

  var email = String(sheet.getRange(row, SEG_COL.EMAIL + 1).getValue()).trim();
  if (!email) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var membersSheet = ss.getSheetByName(MEMBERS_SHEET);
  if (!membersSheet) return;

  var membersData = membersSheet.getDataRange().getValues();
  var memberHeaders = membersData[0];

  var emailColIdx = memberHeaders.indexOf('Email');
  var firstMsgColIdx = memberHeaders.indexOf('First Message');
  if (emailColIdx === -1 || firstMsgColIdx === -1) return;

  for (var i = 1; i < membersData.length; i++) {
    var memberEmail = String(membersData[i][emailColIdx] || '').trim();
    if (memberEmail.toLowerCase() === email.toLowerCase()) {
      membersSheet.getRange(i + 1, firstMsgColIdx + 1).setValue(bucket + ' DM');
      Logger.log('Marked ' + email + ' as ' + bucket + ' DM in Members (row ' + (i + 1) + ')');
      return;
    }
  }

  Logger.log('WARN: email not found in Members — ' + email);
}

// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------

// Run once from the Apps Script editor to install the 7am daily trigger.
// Safe to call repeatedly — skips if a trigger already exists.
function createDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDailySegmentation') {
      Logger.log('Trigger already exists — no action taken.');
      return;
    }
  }
  ScriptApp.newTrigger('runDailySegmentation').timeBased().everyDays(1).atHour(7).create();
  Logger.log('Daily 7am trigger created for runDailySegmentation.');
}

function _appendSyncLog(ss, event, status, detail) {
  var logSheet = ss.getSheetByName(SYNC_LOG_SHEET);
  if (!logSheet) return;
  logSheet.appendRow([new Date().toISOString(), event, status, detail]);
}
