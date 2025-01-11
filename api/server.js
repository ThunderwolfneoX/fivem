const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp');
const https = require('https');
const NodeCache = require('node-cache');

const app = express();
app.use(cors());
const port = 8080;

// Inisialisasi cache dengan TTL default 1 menit
const cache = new NodeCache({ stdTTL: 60 });

// Discord Webhook URL
const discordWebhookUrl = 'https://discord.com/api/webhooks/1327531098510458982/woS_zeaiti7fqFMgYcC-O_h4XeLqk8NTXcY9TVVfOOgwu78Iq_GWd5DmyhuxDLn2iPm5';

// Fungsi untuk mengirim log ke Discord webhook
async function writeLog(message) {
  const now = new Date();
  const wibOffset = 7 * 60 * 60 * 1000; // Offset dalam milidetik untuk WIB (UTC+7)
  const wibTime = new Date(now.getTime() + wibOffset);
  const timestamp = wibTime.toISOString().replace('T', ' ').slice(0, 19); // Format: YYYY-MM-DD HH:MM:SS

  const logMessage = `LOG GOOGLE BACKEND [${timestamp} WIB] ${message}`;
  console.log(logMessage); // Tetap log ke konsol untuk debug lokal

  try {
    await axios.post(discordWebhookUrl, {
      content: logMessage,
    });
  } catch (error) {
    console.error(`Failed to send log to Discord: ${error.message}`);
  }
}

// Variabel untuk melacak kegagalan sinkronisasi
let failCount = 0;
let externalDown = false;

const hexToDecimal = (s) => {
  let i, j, digits = [0], carry;
  for (i = 0; i < s.length; i += 1) {
    carry = parseInt(s.charAt(i), 16);
    for (j = 0; j < digits.length; j += 1) {
      digits[j] = digits[j] * 16 + carry;
      carry = (digits[j] / 10) | 0;
      digits[j] %= 10;
    }
    while (carry > 0) {
      digits.push(carry % 10);
      carry = (carry / 10) | 0;
    }
  }
  return digits.reverse().join('');
};

const getSteamProfileUrl = (ids) => {
  const filteredIdentifiers = ids.filter((identifier) => identifier.startsWith('steam:'));
  if (filteredIdentifiers.length > 0) {
    const steamId = hexToDecimal(filteredIdentifiers[0].split(':')[1]);
    return `https://steamcommunity.com/profiles/${steamId}`;
  }
  return null;
};

const getDiscordId = (ids) => {
  const filteredIdentifiers = ids.filter((identifier) => identifier.startsWith('discord:'));
  if (filteredIdentifiers.length > 0) {
    return filteredIdentifiers[0].split(':')[1];
  }
};

const getDiscordDetails = async (discordId) => {
  try {
    const response = await axios.get(`https://discordlookup.mesalytic.moe/v1/user/${discordId}`);
    if (response.data) {
      const { id, username, avatar } = response.data;

      let avatarUrl = "https://i.imgur.com/vneLxLB.png";
      if (avatar && avatar.id) {
        avatarUrl = `https://cdn.discordapp.com/avatars/${id}/${avatar.id}`;
      }

      return {
        id,
        username,
        avatarUrl,
      };
    }
  } catch (error) {
    writeLog(`Error fetching Discord user details: ${error.message}`);
    return null;
  }
};

async function getImageSize(imageUrl) {
  try {
    const response = await axios({
      method: 'get',
      url: imageUrl,
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    const imageBuffer = Buffer.from(response.data, 'binary');
    const metadata = await sharp(imageBuffer).metadata();
    return {
      width: metadata.width,
      height: metadata.height,
    };
  } catch (error) {
    writeLog(`Error fetching image size: ${error.message}`);
    return null;
  }
}

async function fetchServerData() {
  let retries = 5; // Maksimal 5 kali percobaan
  const retryDelay = 5000; // Jeda 5 detik antar percobaan
  let response;

  while (retries > 0) {
    try {
      response = await axios.get('https://servers-frontend.fivem.net/api/servers/single/4ylb3o', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://servers.fivem.net',
          'Referer': 'https://servers.fivem.net/',
        },
        timeout: 5000, // Timeout 5 detik
        validateStatus: (status) => status < 500, // Hanya status di bawah 500 yang valid
      });

      if (response.status === 200) {
        return response.data.Data; // Data berhasil diambil
      }

      retries--;
      writeLog(`Retrying to fetch server data. Remaining attempts: ${retries}`);
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay)); // Tunggu sebelum mencoba ulang
      }
    } catch (error) {
      retries--;
      writeLog(`Retry attempt failed: ${error.message}`);
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay)); // Tunggu sebelum mencoba ulang
      }
    }
  }

  throw new Error(`Failed to fetch data after retries. Status: ${response?.status}`);
}


async function syncServerData() {
  try {
    writeLog('Starting data synchronization...');
    const cacheKeys = cache.keys();
    if (!cacheKeys.length) {
      writeLog('Cache is empty, initiating data fetch.');
    }

    const serverData = await fetchServerData();
    failCount = 0;
    externalDown = false;

    let bannerSize = null;
    if (serverData?.vars?.banner_connecting) {
      bannerSize = await getImageSize(serverData.vars.banner_connecting);
    }

    const serverDetail = {
      totalplayer: serverData?.clients ?? 0,
      maxplayer: serverData?.sv_maxclients ?? 0,
      hostname: serverData?.hostname ?? 'Unknown',
      discord: serverData?.vars?.Discord ?? '',
      banner: {
        url: serverData?.vars?.banner_connecting ?? '',
        size: bannerSize ? `${bannerSize.width}x${bannerSize.height}` : 'Unknown',
      },
      logofivem: serverData?.ownerAvatar ?? '',
      players: serverData?.players ?? [],
    };

    cache.set('serverDetail', serverDetail);
    writeLog('Data successfully synchronized.');
  } catch (error) {
    failCount++;
    writeLog(`Synchronization failed ${failCount} times: ${error.message}`);
    if (failCount >= 10) {
      externalDown = true;
      writeLog('External server marked as down after 10 failed attempts.');
    }
  }
}

// Sinkronisasi awal dan pengaturan interval
syncServerData();
setInterval(syncServerData, 30000);

function checkExternalStatus(req, res, next) {
  if (externalDown) {
    writeLog('External server is down. Blocking request.');
    return res.status(503).json({ error: 'server eksternal mati' });
  }
  next();
}

// Endpoint API
app.get('/serverdetail', checkExternalStatus, (req, res) => {
  const serverDetail = cache.get('serverDetail');
  if (!serverDetail) {
    writeLog('Server detail not available. Returning error.');
    return res.status(503).json({ error: 'Data belum tersedia, coba lagi nanti.' });
  }

  const { players, ...result } = serverDetail;
  writeLog('Server detail request processed.');
  res.json(result);
});

app.get('/playerlist', checkExternalStatus, async (req, res) => {
  const serverDetail = cache.get('serverDetail');
  if (!serverDetail) {
    writeLog('Player list not available. Returning error.');
    return res.status(503).json({ error: 'Data belum tersedia, coba lagi nanti.' });
  }

  try {
    const playerlist = await Promise.all(
      (serverDetail.players || []).map(async (player) => {
        const steamProfileUrl = getSteamProfileUrl(player.identifiers ?? []);
        const discordId = getDiscordId(player.identifiers ?? []);
        let discordDetails = null;

        if (discordId) {
          discordDetails = await getDiscordDetails(discordId);
          if (discordDetails) {
            discordDetails = {
              discordId: discordDetails.id,
              usernameDiscord: discordDetails.username,
              discordPhoto: discordDetails.avatarUrl,
            };
          }
        }

        return {
          id: player.id ?? '',
          name: player.name ?? 'Unknown',
          ping: player.ping ?? 0,
          steamProfileUrl: steamProfileUrl,
          discordDetails: discordDetails,
        };
      })
    );

    writeLog('Player list request processed.');
    res.json({ playerlist });
  } catch (error) {
    writeLog(`Error processing player list: ${error.message}`);
    res.status(500).json({ error: 'Terjadi kesalahan saat memproses data pemain.' });
  }
});

app.get('/', (req, res) => {
  res.status(200).json({ status: 'API OK' });
});

app.listen(port, () => {
  writeLog(`Server is running on http://localhost:${port}`);
});
