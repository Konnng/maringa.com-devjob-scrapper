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
const Slack = require('slack-node');
// /REQUIRES --------------------------------------------------------------------------------------

const dbFile = path.join(__dirname, 'data/db.json');
if (!fs.existsSync(path.dirname(dbFile)) && !fs.mkdirsSync(path.dirname(dbFile))) {
  throw new Error('Error creating data dir.');
}
const db = low(dbFile, { storage: lowDbFileAsync, writeOnChange: true });

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

keywords.forEach((item, index) => {
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
      let keyword = item

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
        let date_processed = Date.now()

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

        row = { id, title, company, date, date_processed, is_filled: isFilled, keyword, bot_processed: false, url: `http://www.maringa.com/empregos/vaga/${id}/` };

        db.get('jobs').push(row).value();
      });

      keywordsProcessed = index + 1;

      if (keywordsProcessed === keywords.length) {
        deferred.resolve();
      }
    });
  });
});

Q.when(deferred.promise).then(() => {
  let cuttingTime = 1484186400245

  console.log('generating html...');

  try {
    db.set('settings.updated_at', Date.now()).value();

    let outputFile = path.join(__dirname, 'out/jobs.html');
    let html = fs.readFileSync(path.join(__dirname, 'tpl/jobs.ejs'), 'utf8');

    let jobs = db.get('jobs').filter({ is_filled: false }).sortBy('date').reverse().value() || [];
    let result = tpl.render(html, { jobs, moment, updated_at: db.get('settings.updated_at').value() || Date.now() });

    if (!fs.existsSync(path.dirname(outputFile)) && !fs.mkdirsSync(path.dirname(outputFile))) {
      throw new Error('Error creating output directory.');
    }

    fs.writeFileSync(outputFile, result);
//  INTEGRATION WITH DEVPARANA SLACK --------------------------------------------------------------------------------------------
    console.log('Done generating HTML file: ', outputFile);
    console.log('Cheking for new job entries to send to Slack...')
    let botJobs = db.get('jobs').filter({ bot_processed: false }).filter({ is_filled: false }).filter(row => row.date_processed >= cuttingTime).sortBy('date').reverse().value()
    sleep(1000)
    if (botJobs.length) {
      console.log('Found ' + botJobs.length +  ' entries to be posted on slack.');

      let slack = new Slack();
      slack.setWebhook('https://hooks.slack.com/services/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');

      botJobs.forEach((item, index) => {
        console.log('Processing item ' + (index + 1) + '...');
        slack.webhook({
          attachments: [
            {
              title: item.title + ' / ' + item.company,
              title_link: item.url,
              text: 'Vaga: ' + item.title + '\nEmpresa: ' + item.company + '\nData: ' + moment(item.date).format('DD/MM/YYYY'),
              color: '#7CD197'
            }
          ],
          text: 'Vaga de trabalho encontrada. Confira! \n\n' + item.url,
        }, function(err, response) {
          if (err) {
            console.error(err);
            console.error('-'.repeat(100));
            process.exit(1);
          }
          if (response.statusCode === 200) {
            db.get('jobs').find({ id: item.id }).assign({ bot_processed: true }).value();
          }
        });
        sleep(1000);
      });
    } else {
      console.log('No new job opening found to send to slack.')
    }
//  /INTEGRATION WITH DEVPARANA SLACK -------------------------------------------------------------------------------------------
  } catch (err) {
    console.error(err);
  }
}, (err) => {
  console.error(err);
  process.exit(1);
});
