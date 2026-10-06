/**
 * BNI IKON - Master Visitor Database + Coffee Session Booking
 * Google Apps Script backend (shared Google Sheet).
 *
 * SHEETS (created / extended automatically - no manual column editing needed):
 *   Visitors      - master list of every online & offline visitor (one row per person)
 *   Bookings      - Coffee Session slots; each links to a visitor via visitorId
 *   BlockedDates  - dates that cannot be booked for Coffee Sessions
 *
 * FIRST-TIME SETUP
 * 1. Open the Google Sheet > Extensions > Apps Script.
 * 2. Replace everything in Code.gs with this file and click Save.
 * 3. Deploy > New deployment > type "Web app", Execute as "Me",
 *    Who has access "Anyone" > Deploy > authorise.
 * 4. Put the Web app URL (ends in /exec) into DEFAULT_API_URL in index.html.
 *
 * UPDATING THIS SCRIPT LATER (keeps the same URL - do NOT use "New deployment")
 *   Deploy > Manage deployments > pencil icon on the existing deployment >
 *   Version: "New version" > Deploy.
 *
 * Do not press "Run" on functions here; the web app calls them itself.
 */

const SHEETS = {
  Visitors: ['id','name','phone','business','channel','source','invitedBy','vhName',
             'visitDate','status','notes','createdAt','updatedAt'],
  Bookings: ['id','date','team','session','apptTime','mode','visitorName','visitorPhone',
             'visitorBusiness','inviteeName','vhName','location','outcome','remarks','visitorId'],
  BlockedDates: ['date','reason']
};

// Coffee Session outcome -> visitor follow-up status
const OUTCOME_TO_STATUS = {
  'Pending': 'Invited',
  'Filled in Form': 'Filled Form',
  'Interested to join BNI': 'Interested',
  'Not interested to join yet': 'Not Now',
  'Interested to join BNI IKON END Event': 'Interested'
};

// ---------- sheet helpers ----------

/** Returns the sheet, creating it or appending any missing header columns. */
function getSheet(name){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wanted = SHEETS[name];
  let sheet = ss.getSheetByName(name);
  if(!sheet){
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, wanted.length).setValues([wanted]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const have = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = wanted.filter(h => have.indexOf(h) === -1);
  if(missing.length){
    const start = have.filter(h => h !== '').length + 1;
    sheet.getRange(1, start, 1, missing.length).setValues([missing]);
  }
  return sheet;
}

function pad2(n){ return (n < 10 ? '0' : '') + n; }

function normalizeValue(header, val){
  if(val === undefined || val === null) return '';
  if(Object.prototype.toString.call(val) === '[object Date]'){
    const tz = Session.getScriptTimeZone();
    if(header === 'apptTime') return Utilities.formatDate(val, tz, 'HH:mm');
    if(header === 'createdAt' || header === 'updatedAt') return val.toISOString();
    return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
  }
  return String(val);
}

/** Reads a sheet into objects, matching columns by header name (column order doesn't matter). */
function readTable(name){
  const sheet = getSheet(name);
  const data = sheet.getDataRange().getValues();
  if(data.length < 2) return [];
  const hdr = data[0].map(String);
  return data.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const obj = {};
      SHEETS[name].forEach(h => {
        const i = hdr.indexOf(h);
        obj[h] = i === -1 ? '' : normalizeValue(h, row[i]);
      });
      return obj;
    });
}

/** Inserts or updates one row by key. Only fields present in `record` are overwritten. */
function upsertRow(name, record, key){
  key = key || 'id';
  const sheet = getSheet(name);
  const data = sheet.getDataRange().getValues();
  const hdr = data[0].map(String);
  const keyIdx = hdr.indexOf(key);
  let rowIndex = -1;
  for(let i = 1; i < data.length; i++){
    if(normalizeValue(key, data[i][keyIdx]) === String(record[key])){ rowIndex = i; break; }
  }
  const existing = rowIndex > 0 ? data[rowIndex] : null;
  const row = hdr.map((h, c) => {
    if(record[h] !== undefined) return record[h] === null ? '' : String(record[h]);
    return existing ? existing[c] : '';
  });
  const target = rowIndex > 0
    ? sheet.getRange(rowIndex + 1, 1, 1, row.length)
    : sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
  target.setNumberFormat('@'); // keep phone numbers, dates and times as typed
  target.setValues([row]);
}

function deleteRows(name, field, value){
  const sheet = getSheet(name);
  const data = sheet.getDataRange().getValues();
  const idx = data[0].map(String).indexOf(field);
  if(idx === -1) return;
  for(let i = data.length - 1; i >= 1; i--){
    if(normalizeValue(field, data[i][idx]) === String(value)) sheet.deleteRow(i + 1);
  }
}

// ---------- visitor matching ----------

/** Comparable phone: digits only, Malaysian 60 prefix -> 0, restores a dropped leading 0. */
function normPhone(p){
  let d = String(p || '').replace(/\D/g, '');
  if(d.indexOf('60') === 0) d = '0' + d.slice(2);
  if(d && d[0] !== '0' && d.length >= 8 && d.length <= 10) d = '0' + d;
  return d;
}

function findVisitor(visitors, id, phone, name){
  if(id){
    const byId = visitors.find(v => v.id === String(id));
    if(byId) return byId;
  }
  const p = normPhone(phone);
  if(p){
    const byPhone = visitors.find(v => normPhone(v.phone) === p);
    if(byPhone) return byPhone;
  }
  const n = String(name || '').trim().toLowerCase();
  if(n && !p){
    return visitors.find(v => !normPhone(v.phone) && v.name.trim().toLowerCase() === n) || null;
  }
  return null;
}

function newId(prefix){ return prefix + Date.now() + Math.floor(Math.random() * 1000); }

/** Creates or updates the visitor behind a Coffee Session booking; returns the visitor id. */
function upsertVisitorFromBooking(b, visitors){
  const now = new Date().toISOString();
  const found = findVisitor(visitors, b.visitorId, b.visitorPhone, b.visitorName);
  const status = OUTCOME_TO_STATUS[b.outcome] || 'Invited';
  if(found){
    const update = {id: found.id, name: b.visitorName, updatedAt: now};
    if(b.visitorPhone) update.phone = b.visitorPhone;
    if(b.visitorBusiness) update.business = b.visitorBusiness;
    if(b.vhName) update.vhName = b.vhName;
    if(b.outcome && b.outcome !== 'Pending') update.status = status;
    upsertRow('Visitors', update);
    Object.assign(found, update);
    return found.id;
  }
  const v = {
    id: newId('v'), name: b.visitorName, phone: b.visitorPhone || '', business: b.visitorBusiness || '',
    channel: b.mode || 'Offline', source: 'Coffee Session', invitedBy: b.inviteeName || '',
    vhName: b.vhName || '', visitDate: b.date || '', status: status, notes: b.remarks || '',
    createdAt: now, updatedAt: now
  };
  upsertRow('Visitors', v);
  visitors.push(v);
  return v.id;
}

/** One-off: builds the Visitors sheet from existing Coffee Session bookings. */
function migrateBookingsToVisitors(){
  const props = PropertiesService.getScriptProperties();
  if(props.getProperty('visitorsMigrated') === 'yes') return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    if(props.getProperty('visitorsMigrated') === 'yes') return;
    const visitors = readTable('Visitors');
    readTable('Bookings').forEach(b => {
      if(b.visitorId) return;
      b.visitorId = upsertVisitorFromBooking(b, visitors);
      upsertRow('Bookings', {id: b.id, visitorId: b.visitorId});
    });
    props.setProperty('visitorsMigrated', 'yes');
  } finally {
    lock.releaseLock();
  }
}

// ---------- actions ----------

function saveVisitor(record){
  const visitors = readTable('Visitors');
  const now = new Date().toISOString();
  let existing = record.id ? visitors.find(v => v.id === String(record.id)) : null;
  if(!existing){
    // Same phone already in the database -> update that person instead of duplicating.
    existing = findVisitor(visitors, null, record.phone, null);
  }
  const v = Object.assign({}, record, {
    id: existing ? existing.id : newId('v'),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  });
  upsertRow('Visitors', v);
  return {id: v.id, merged: !!(existing && !record.id)};
}

function saveBooking(record){
  const visitors = readTable('Visitors');
  record.visitorId = upsertVisitorFromBooking(record, visitors);
  upsertRow('Bookings', record);
  return {id: record.id, visitorId: record.visitorId};
}

function deleteVisitor(id){
  deleteRows('Bookings', 'visitorId', id);
  deleteRows('Visitors', 'id', id);
}

function addBlocked(record){
  const exists = readTable('BlockedDates').some(b => b.date === String(record.date));
  if(!exists) upsertRow('BlockedDates', record, 'date');
}

// ---------- web app entry points ----------

function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e){
  migrateBookingsToVisitors();
  return json({
    visitors: readTable('Visitors'),
    bookings: readTable('Bookings'),
    blocked: readTable('BlockedDates')
  });
}

function doPost(e){
  const lock = LockService.getScriptLock();
  try{
    lock.waitLock(20000);
    const body = JSON.parse(e.postData.contents);
    let result = {};
    switch(body.action){
      case 'saveVisitor':   result = saveVisitor(body.record); break;
      case 'deleteVisitor': deleteVisitor(body.id); break;
      case 'saveBooking':   result = saveBooking(body.record); break;
      case 'deleteBooking': deleteRows('Bookings', 'id', body.id); break;
      case 'addBlocked':    addBlocked(body.record); break;
      case 'deleteBlocked': deleteRows('BlockedDates', 'date', body.date); break;
      default: return json({success: false, error: 'Unknown action: ' + body.action});
    }
    return json(Object.assign({success: true}, result));
  } catch(err){
    return json({success: false, error: err.message});
  } finally {
    lock.releaseLock();
  }
}
