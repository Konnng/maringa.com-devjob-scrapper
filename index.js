/**
 *
 */

// REQUIRES ---------------------------------------------------------------------------------------
const tpl = require('ejs');
const low = require('lowdb');
const lowDbFileAsync = require('lowdb/lib/file-async');
const http = require('http');
const Q = require('q');
const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const sleep = require('system-sleep');
const moment = require('moment');
// /REQUIRES --------------------------------------------------------------------------------------

const db_file = path.join(__dirname, 'data/db.json');
if (!fs.existsSync(path.dirname(db_file)) && !fs.mkdirsSync(path.dirname(db_file))) {
  throw new Error('Error creating data dir.');
}
const db = low(db_file, { storage: lowDbFileAsync, writeOnChange: true });

const scrapperUrlBase = 'http://www.maringa.com/empregos/index.php';
const keywords = [
  'desenvolvedor',
  'programador',
  'web',
  'php',
  'frontend',
  'front-end',
];
const deferred = Q.defer();

db.defaults({ jobs: [], settings: {} }).value();

let keywordsProcessed = 0;

keywords.forEach((item) => {
  let url = `${scrapperUrlBase}?busca=${encodeURIComponent(item)}&area=&buscar=Buscar`;

  sleep(1000);

  console.log('Processing: ', item);

  http.get(url, (response) => {
    let bodyChunks = [];

    response.on('error', (err) => {
      console.log(err);
      console.log('-'.repeat(100));
    });
    response.on('data', (data) => {
      bodyChunks.push(data);
    });
    response.on('end', () => {
      let body = iconv.decode(Buffer.concat(bodyChunks), 'latin1').toString();
      let $ = cheerio.load(body);
      let jobs = $('#listaVagas tbody tr').length > 0 ? $('#listaVagas tbody tr') : $('#listaVagas tr').slice(1);

      if (jobs.length === 0) {
        return false;
      }

      jobs.each((i, job) => {
        job = $(job);

        let row = null;
        let title = job.find('td').eq(0).contents().eq(0).text().trim();
        let company = job.find('td').eq(1).text().trim();
        let date = job.find('td').eq(2).text().trim();
        let link = job.find('td').eq(0).find('a').attr('href');
        let isFilled = job.find('td').eq(0).find('b').length > 0;

        if (title.length === 0) {
          return;
        }

        let id = Number(link.match(/verVaga\((\d*)/i)[1] || 0);
        if (isNaN(id)) {
          return;
        }

        if (date.toLowerCase() === 'hoje') {
          date = new Date();
        } else {
          date = new Date(date.toString().split('/').reverse().join('-'));
        }

        date.setHours(0, 0, 0, 0);
        date = date.getTime();

        row = db.get('jobs').find({ id }).value();

        if (row) {
          if (!row.is_filled && isFilled) {
            db.get('jobs').find({ id }).assign({ is_filed: isFilled }).value();
          }

          return;
        }

        row = { id, title, company, date, is_filled: isFilled, url: `http://www.maringa.com/empregos/vaga/${id}/` };

        db.get('jobs').push(row).value();
      });

      keywordsProcessed++;

      if (keywordsProcessed === keywords.length) {
        deferred.resolve();
      }
    });
  });
});

Q.when(deferred.promise).then(() => {
  console.log('generating html...');

  try {
    db.set('settings.updated_at', Date.now()).value();

    let outputFile = path.join(__dirname, 'out/jobs.html');
    let html = fs.readFileSync(path.join(__dirname, 'tpl/jobs.ejs'), 'utf8');

    let jobs = db.get('jobs').filter({ is_filled: false }).sortBy('date').reverse().value() || [];
    let result = tpl.render(html, { jobs, moment: moment, updated_at: db.get('settings.updated_at').value() || Date.now() });

    if (!fs.existsSync(path.dirname(outputFile)) && !fs.mkdirsSync(path.dirname(outputFile))) {
      throw new Error('Error creating output directory.');
    }

    fs.writeFileSync(outputFile, result);

    console.log('Done ', outputFile);
  } catch (err) {
    console.error(err);
  }
}, (err) => {
  console.error(err);
  process.exit(1);
});

// process.stdin.once('data', () => {
//   process.stdin.unref();
// });
