/**
 * BNI IKON Coffee Session Booking - Shared Database Backend
 *
 * SETUP INSTRUCTIONS:
 * 1. Go to https://sheets.google.com and create a new blank spreadsheet.
 *    Name it e.g. "BNI IKON Coffee Session Database".
 * 2. In the sheet menu, go to Extensions > Apps Script.
 * 3. Delete any default code in Code.gs and paste this entire file in its place.
 * 4. Click "Deploy" > "New deployment".
 *    - Click the gear icon next to "Select type" and choose "Web app".
 *    - Description: anything (e.g. "BNI IKON API")
 *    - Execute as: "Me"
 *    - Who has access: "Anyone"
 * 5. Click "Deploy". The first time, Google will ask you to authorize the
 *    script - click "Authorize access", choose your Google account, then
 *    "Advanced" > "Go to ... (unsafe)" > "Allow" (this is your own script,
 *    it's safe).
 * 6. Copy the "Web app URL" shown (it looks like
 *    https://script.google.com/macros/s/XXXXXXXXXXXX/exec).
 * 7. Paste that URL into the BNI IKON booking app's Admin tab,
 *    under "Shared Data Source", and click "Save & Connect".
 *
 * The script will automatically create two sheets the first time it runs:
 * "Bookings" and "BlockedDates".
 *
 * NOTE: If you edit this script later, you must create a NEW deployment
 * version (Deploy > Manage deployments > Edit > New version) for changes
 * to take effect on the existing web app URL.
 */

const SHEET_BOOKINGS = 'Bookings';
const SHEET_BLOCKED = 'BlockedDates';

const HEADERS_BOOKINGS = ['id','date','team','session','mode','visitorName','visitorBusiness','inviteeName','vhName','outcome','remarks'];
const HEADERS_BLOCKED = ['date','reason'];

function getSheet(name, headers){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if(!sheet){
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function normalizeValue(header, val){
  if(val === undefined || val === null) return '';
  if(header === 'date'){
    if(Object.prototype.toString.call(val) === '[object Date]'){
      return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    return String(val);
  }
  if(header === 'id'){
    return String(val);
  }
  return String(val);
}

function readAll(sheetName, headers){
  const sheet = getSheet(sheetName, headers);
  const data = sheet.getDataRange().getValues();
  if(data.length < 2) return [];
  return data.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row=>{
      const obj = {};
      headers.forEach((h,i)=> obj[h] = normalizeValue(h, row[i]));
      return obj;
    });
}

function doGet(e){
  const bookings = readAll(SHEET_BOOKINGS, HEADERS_BOOKINGS);
  const blocked = readAll(SHEET_BLOCKED, HEADERS_BLOCKED);
  return ContentService.createTextOutput(JSON.stringify({bookings, blocked}))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e){
  let result;
  try{
    const body = JSON.parse(e.postData.contents);
    switch(body.action){
      case 'saveBooking':
        saveBooking(body.record);
        result = {success:true};
        break;
      case 'deleteBooking':
        deleteRowByKey(SHEET_BOOKINGS, HEADERS_BOOKINGS, 'id', body.id);
        result = {success:true};
        break;
      case 'addBlocked':
        addBlocked(body.record);
        result = {success:true};
        break;
      case 'deleteBlocked':
        deleteRowByKey(SHEET_BLOCKED, HEADERS_BLOCKED, 'date', body.date);
        result = {success:true};
        break;
      default:
        result = {success:false, error:'Unknown action: ' + body.action};
    }
  } catch(err){
    result = {success:false, error: err.message};
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function saveBooking(record){
  const sheet = getSheet(SHEET_BOOKINGS, HEADERS_BOOKINGS);
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for(let i=1;i<data.length;i++){
    if(normalizeValue('id', data[i][0]) === String(record.id)){
      rowIndex = i+1;
      break;
    }
  }
  const row = HEADERS_BOOKINGS.map(h => record[h] !== undefined ? record[h] : '');
  if(rowIndex > 0){
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

function addBlocked(record){
  const sheet = getSheet(SHEET_BLOCKED, HEADERS_BLOCKED);
  const data = sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(normalizeValue('date', data[i][0]) === String(record.date)){
      return; // already blocked, no duplicate
    }
  }
  sheet.appendRow(HEADERS_BLOCKED.map(h => record[h] !== undefined ? record[h] : ''));
}

function deleteRowByKey(sheetName, headers, keyField, keyValue){
  const sheet = getSheet(sheetName, headers);
  const data = sheet.getDataRange().getValues();
  const keyIndex = headers.indexOf(keyField);
  for(let i=1;i<data.length;i++){
    if(normalizeValue(keyField, data[i][keyIndex]) === String(keyValue)){
      sheet.deleteRow(i+1);
      break;
    }
  }
}
