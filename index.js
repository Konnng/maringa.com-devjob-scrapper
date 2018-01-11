// REQUIRES ---------------------------------------------------------------------------------------
const tpl = require('ejs');
const low = require('lowdb');
const lowDbFileAsync = require('lowdb/lib/file-async');
const request = require('request-promise');
const Q = require('q');
const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');
const sleep = require('system-sleep');
const moment = require('moment');
const Slack = require('slack-node');
const Regex = require('xregexp');
// /REQUIRES --------------------------------------------------------------------------------------

const SLACK_WEBHOOK = process.env.LABS_SLACK_WEBHOOK_URL_DEVPARANA || '';
const dbFile = path.join(__dirname, 'data/db.json');
if (!fs.existsSync(path.dirname(dbFile)) && !fs.mkdirsSync(path.dirname(dbFile))) {
  throw new Error('Error creating data dir.');
}
const db = low(dbFile, { storage: lowDbFileAsync, writeOnChange: true });

const scrapperUrlBase = 'http://empregos.maringa.com/';
const keywords = [
  'desenvolvedor',
  'programador',
  'web',
  'php',
  'frontend',
  'front-end',
];

// blacklist certain words / expressions in title, to filter found Jobs
const blacklist = [
  'torno',
  'cnc',
  'ppcp',
  'usinagem',
  /venda?s/ig,
  /vendedor/ig,
  /servi[\xE7\xC7]os?/ig,
  /ve[\xCD\xED]culos?/ig,
  /manuten[\xC7\xE7][\xC3\xE3]o/ig,
  /neg[\xF3\xD3]cios?/ig,
  // NOTE: if you decide to use regular expression, don't forget the "ig" flags
];

const deferred = Q.defer();
const deferredProcessing = Q.defer();
const deferredSlack = Q.defer();

db.defaults({ jobs: [], settings: {} }).value();

let keywordsProcessed = 0;
let websiteToken = '';
let websiteCookies = [];

request({
  uri: scrapperUrlBase,
  transform: (body, response) => {
    const res = { headers: response.headers, statusCode: response.statusCode, body };

    return res;
  },
}).then((response) => {
  if (response.statusCode !== 200) {
    deferred.reject(new Error('Erro ao obter token e cookies'));
    return false;
  }

  const $ = cheerio.load(response.body);

  websiteCookies = (response.headers['set-cookie'] || []).map((cookie) => {
    const ck = new request.cookie(cookie);

    return ck;
  });

  websiteToken = $('input[name="_token"]').val();

  return websiteToken && websiteCookies.length ? deferred.resolve() : deferred.reject(new Error('Token de busca inválido.'));
}).catch((err) => {
  _log('ERROR');
  _log(err);
  _log('-'.repeat(100));
  process.exit(1);
});

Q.when(deferred.promise).then(() => {
  sleep(1000);


  const cookieJar = request.jar();
  websiteCookies.forEach((cookie) => {
    cookieJar.setCookie(cookie, scrapperUrlBase);
  });

  keywords.forEach((keyword, index) => {
    _log(`Looking for jobs with word "${keyword}`);

    let foundJobs = [];

    request.post(
      scrapperUrlBase,
      {
        jar: cookieJar,
        form: {
          _token: websiteToken,
          text: keyword,
          estado: 'PR',
          cidade: 'Maringá',
          area: '',
          faixa_salarial: '',
        },
      }
    ).then((response) => {
      const $ = cheerio.load(response);

      $('.table-vagas').find('.clickable-row ').each((i, job) => {
        const $job = $(job);

        const title = $job.find('td').eq(1).find('p').eq(0).find('strong').text().trim().replace(/[\r\n]/g, '');
        const company = $job.find('td').eq(1).find('p').eq(1).text().trim().replace(/empresa: /i, '');
        const link = $job.data('href');

        // TODO: checar se existe flag de vaga preenchida no site
        const isFilled = $job.find('td').eq(1).find('p').eq(0).find('.badge-success').length > 0;
        const dateProcessed = Date.now();
        const id = (link.match(/vaga-emprego\/(\d+)\//) || []).pop();

        if (isNaN(id)) {
          return;
        }

        let row = null;
        let date = $job.find('td').eq(2).find('p').eq(0).text().trim();

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

        foundJobs.push({
          id,
          title,
          company,
          date,
          date_processed: dateProcessed,
          is_filled: isFilled,
          keyword,
          bot_processed: false,
          url: link,
        });
      });

      foundJobs = foundJobs.filter((job) => {
        const test = blacklist.filter((word) => {
          const regex = word.constructor !== RegExp ? new RegExp(`\\b${word}\\b`, 'igm') : word;

          return Regex(regex).test(job.title);
        });

        return test.length === 0;
      });

      _log(`Found ${foundJobs.length} job opportunities...`);
      _log('-'.repeat(100));

      foundJobs.forEach((job) => {
        db.get('jobs').push(job).value();
      });

      keywordsProcessed = index + 1;

      if (keywordsProcessed === keywords.length) {
        setTimeout(() => { deferredProcessing.resolve(); }, 1000);
      }
    }).catch((err) => {
      _log('ERROR');
      _log(err);
      _log('-'.repeat(100));
    })
  });
}, (err) => {
  _log('ERROR');
  _log(err);
  _log('-'.repeat(100));
});

Q.when(deferredProcessing.promise).then(() => {
  let cuttingTime = 1484186400245;

  _log('generating html...');

  try {
    db.set('settings.updated_at', Date.now()).value();

    const outputFile = path.join(__dirname, 'out/jobs.html');
    const html = fs.readFileSync(path.join(__dirname, 'tpl/jobs.ejs'), 'utf8');

    const jobs = db.get('jobs').filter({ is_filled: false }).sortBy('date').reverse().value() || [];
    const result = tpl.render(html, { jobs, moment, updated_at: db.get('settings.updated_at').value() || Date.now() });

    if (!fs.existsSync(path.dirname(outputFile)) && !fs.mkdirsSync(path.dirname(outputFile))) {
      throw new Error('Error creating output directory.');
    }

    fs.writeFileSync(outputFile, result);

//  INTEGRATION WITH DEVPARANA SLACK --------------------------------------------------------------------------------------------
    _log('Done generating HTML file: ', outputFile);
    _log('Cheking for new job entries to send to Slack...')

    const botJobs = db.get('jobs').filter({ bot_processed: false })
      .filter({ is_filled: false }).filter(row => row.date_processed >= cuttingTime)
      .sortBy('date').reverse().value();

    sleep(1000);

    if (SLACK_WEBHOOK && botJobs.length) {
      _log(`Found ${botJobs.length} entries to be posted on slack.`);

      let slack = new Slack();
      slack.setWebhook(SLACK_WEBHOOK);

      botJobs.forEach((item, index) => {
        _log(`Processing item ${(index + 1)}:`, `${item.title} / ${item.company}`);

        slack.webhook({
          attachments: [
            {
              title: `${item.title} / ${item.company}`,
              title_link: item.url,
              text: `Vaga:  ${item.title}\nEmpresa: ${item.company}\nData${moment(item.date).format('DD/MM/YYYY')}`,
              color: '#7CD197',
            },
          ],
          text: `Vaga de trabalho encontrada. Confira!\n\n${item.url}`,
        }, (err, response) => {
          if (err) {
            _log('ERROR: ', err);
            _log('ERROR: ', '-'.repeat(100));
            process.exit(1);
          }
          if (response.statusCode === 200) {
            _log('Done posting item ' + (index + 1));
            db.get('jobs').find({ id: item.id }).assign({ bot_processed: true }).value();
          } else {
            _log('ERROR: ', 'Error processing item ' + (index + 1) + ': ', response.statusCode, response.statusMessage);
          }

          if (index + 1 === botJobs.length) {
            deferredSlack.resolve('DONE');
          }
        });
        sleep(300);
      });
    } else if (!SLACK_WEBHOOK) {
      deferredSlack.reject(new Error('ERROR: Enviroment variable "SLACK_WEBHOOK" is not defined. Aborting slack...'));
    } else {
      deferredSlack.resolve('No new job opening found to send to slack.');
    }
//  /INTEGRATION WITH DEVPARANA SLACK -------------------------------------------------------------------------------------------
    Q.when(deferredSlack.promise).then((msg) => {
      _log(msg);
      _log('-'.repeat(100));
    }, (err) => {
      _log('ERROR');
      _log(err);
      _log('-'.repeat(100));
      process.exit(1);
    });
  } catch (err) {
    _log('ERROR: ', err);
  }
  _log('-'.repeat(100));
}, (err) => {
  _log('ERROR: ', err);
  _log('-'.repeat(100));
  process.exit(1);
});

function _log(...args) {
  console.log(...[].concat([`[${moment().format('DD/MM/YYYY HH:mm:ss')}] =>`], Array.from(args) || []));
}
