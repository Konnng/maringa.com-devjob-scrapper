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

const db = low('db.json', { storage: lowDbFileAsync, writeOnChange: true });
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

db.defaults({ jobs: [] }).value();

let keywordsProcessed = 0;

keywords.forEach((item) => {
  let url = `${scrapperUrlBase}?busca=${encodeURIComponent(item)}&area=&buscar=Buscar`;

  sleep(1000);

  console.log('Processing: ', item);

  http.get(url, (response) => {
    let body_chunks = [];

    response.on('error', (err) => {
      console.log(err);
      console.log('-'.repeat(100));
    });
    response.on('data', (data) => {
      body_chunks.push(data);
    });
    response.on('end', () => {
      let body = iconv.decode(Buffer.concat(body_chunks), 'latin1').toString();
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

  let jobs = db.get('jobs').filter({ is_filled: false }).sortBy('date').reverse().value() || [];
  let html = fs.readFileSync(path.join(__dirname, 'tpl/jobs.ejs'), 'utf8');
  let result = tpl.render(html, { jobs, moment: moment });
  let outputFile = path.join(__dirname, 'out/jobs.html');

  if (!fs.existsSync(path.dirname(outputFile)) && !fs.mkdirsSync(path.dirname(outputFile)))
    throw 'Error creating output directory.';

  fs.writeFileSync(outputFile, result);

  console.log('Done ', outputFile);
}, (err) => {
  console.error(err);
  process.exit(1);
});

// process.stdin.once('data', () => {
//   process.stdin.unref();
// });
