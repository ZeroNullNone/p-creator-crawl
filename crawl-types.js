'use strict';

const { fetchArchivePosts, validateArchiveUrl } = require('./crawl-archive');
const { scrapeSubstack } = require('./scraper');

// Register implemented list crawlers here. The page reads their public metadata.
module.exports = {
  'substack-archive': {
    label: 'Substack Archive',
    description: 'VertoxQuant verified. Other Substack archives are checked when scanned.',
    placeholder: 'https://publication.example/archive',
    cookieSource: 'substack',
    validateUrl: validateArchiveUrl,
    scan: fetchArchivePosts,
    scrape: scrapeSubstack,
  },
};
