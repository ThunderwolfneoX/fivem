const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp');
const https = require('https');
const NodeCache = require('node-cache');

// URL Webhook Discord Anda
// Ganti dengan URL real milik Anda (dari instruksi: https://discord.com/api/webhooks/...)
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1329492507989377108/xLMfjORk7UTSTDikZvKT5mMEtaqYz4Z9JCp_Zr7mYA1p9DG4TsZwRJM6m0aMiy9JOlRg';

const app = express();
const port = 8080;

app.use(cors());

// ----------------------------------------------------------------
// 0. Fungsi penulisan log -> kirim ke Discord Webhook
// ----------------------------------------------------------------
async function writeLog(message) {
  try {
    // Dapatkan string waktu dengan timeZone Asia/Jakarta
    const dateJakarta = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Jakarta',
      hour12: false, // kalau ingin format 24 jam
    });
    
    // Susun pesan log
    const logMessage = `[${dateJakarta}] ${message}`;
    
    // Kirim log ke Discord Webhook
    await axios.post(DISCORD_WEBHOOK_URL, {
      content: logMessage
    });
  } catch (error) {
    console.error(`Failed to send log to Discord: ${error.message}`);
  }
}


// ----------------------------------------------------------------
// 1. Setup NodeCache (untuk menyimpan data FiveM)
// ----------------------------------------------------------------
const serverCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
const FIVEM_CACHE_KEY = 'fivemServerData';

// ----------------------------------------------------------------
// 2. Helper Functions (SteamID, Discord, dsb)
// ----------------------------------------------------------------
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
  const filtered = ids.filter((identifier) => identifier.startsWith('steam:'));
  if (filtered.length > 0) {
    const steamId = hexToDecimal(filtered[0].substring(filtered[0].indexOf(':') + 1));
    return `https://steamcommunity.com/profiles/${steamId}`;
  }
  return null;
};

const getDiscordId = (ids) => {
  const filtered = ids.filter((identifier) => identifier.startsWith('discord:'));
  if (filtered.length > 0) {
    return filtered[0].substring(filtered[0].indexOf(':') + 1);
  }
  return null;
};

const getDiscordDetails = async (discordId) => {
  try {
    // await writeLog(`[getDiscordDetails] Fetching data for Discord ID: ${discordId}`);
    const response = await axios.get(`https://discordlookup.mesalytic.moe/v1/user/${discordId}`);
    if (response.data) {
      const { id, username, avatar } = response.data;
      // await writeLog(`[getDiscordDetails] Success -> ID: ${id}, username: ${username}`);
      return {
        id,
        username,
        avatarUrl: avatar 
          ? `https://cdn.discordapp.com/avatars/${id}/${avatar.id}` 
          : "https://via.placeholder.com/64"
      };
    }
    // await writeLog(`[getDiscordDetails] No data found for Discord ID: ${discordId}`);
    return null;
  } catch (error) {
    await writeLog(`[getDiscordDetails] Error: ${error.message}`);
    return null;
  }
};

async function getImageSize(imageUrl) {
  try {
    await writeLog(`[getImageSize] Fetching image size: ${imageUrl}`);
    const response = await axios({
      method: 'get',
      url: imageUrl,
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    const imageBuffer = Buffer.from(response.data, 'binary');
    const metadata = await sharp(imageBuffer).metadata();
    await writeLog(`[getImageSize] -> ${metadata.width}x${metadata.height}`);
    return {
      width: metadata.width,
      height: metadata.height
    };
  } catch (error) {
    await writeLog(`[getImageSize] Error: ${error.message}`);
    return null;
  }
}

// ----------------------------------------------------------------
// 3. Fungsi utama: ambil data dari FiveM (untuk dijalankan periodik)
// ----------------------------------------------------------------
async function fetchFiveMData() {
  try {
    await writeLog(`[fetchFiveMData] Fetching from FiveM...`);
    const config = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://servers.fivem.net',
        'Referer': 'https://servers.fivem.net/'
      },
      timeout: 5000
    };

    const url = 'https://servers-frontend.fivem.net/api/servers/single/4ylb3o';
    const response = await axios.get(url, config);

    if (response.status === 200 && response.data?.Data) {
      serverCache.set(FIVEM_CACHE_KEY, response.data.Data);
      await writeLog(`[fetchFiveMData] Success -> Data cached`);
    } else {
      await writeLog(`[fetchFiveMData] Non-200 status: ${response.status}`);
    }
  } catch (error) {
    await writeLog(`[fetchFiveMData] Error: ${error.message}`);
  }
}

// ----------------------------------------------------------------
// 4. Jalankan fetchFiveMData secara periodik
// ----------------------------------------------------------------
fetchFiveMData(); // panggil pertama kali saat server mulai
setInterval(fetchFiveMData, 30_000); // setiap 30 detik

// ----------------------------------------------------------------
// 5. Endpoint Express
// ----------------------------------------------------------------
app.get('/', async (req, res) => {
  // await writeLog(`[GET /] Health check`);
  res.status(200).json({ status: 'API OK' });
});

app.get('/serverdetail', async (req, res) => {
  // await writeLog(`[GET /serverdetail] Request received`);
  try {
    const serverData = serverCache.get(FIVEM_CACHE_KEY);
    if (!serverData) {
      await writeLog(`[GET /serverdetail] Cache miss -> No data in cache`);
      return res.status(503).json({
        error: 'No data available',
        message: 'Cache is empty, please try again later.'
      });
    }

    let bannerSize = null;
    if (serverData?.vars?.banner_connecting) {
      bannerSize = await getImageSize(serverData.vars.banner_connecting);
    }

    const result = {
      totalplayer: serverData?.clients ?? 0,
      maxplayer: serverData?.sv_maxclients ?? 0,
      hostname: serverData?.hostname ?? 'Unknown',
      discord: serverData?.vars?.Discord ?? '',
      banner: {
        url: serverData?.vars?.banner_connecting ?? '',
        size: bannerSize ? `${bannerSize.width}x${bannerSize.height}` : 'Unknown'
      },
      logofivem: serverData?.ownerAvatar ?? ''
    };

    res.json(result);
    // await writeLog(`[GET /serverdetail] Response sent`);
  } catch (error) {
    await writeLog(`[GET /serverdetail] Error: ${error.message}`);
    res.status(503).json({
      error: 'Service temporarily unavailable',
      message: error.message
    });
  }
});

app.get('/playerlist', async (req, res) => {
  // await writeLog(`[GET /playerlist] Request received`);
  try {
    const serverData = serverCache.get(FIVEM_CACHE_KEY);
    if (!serverData) {
      await writeLog(`[GET /playerlist] Cache miss -> No data in cache`);
      return res.status(503).json({
        error: 'No data available',
        message: 'Cache is empty, please try again later.'
      });
    }

    const playerlist = await Promise.all(
      serverData?.players?.map(async (player) => {
        const steamProfileUrl = getSteamProfileUrl(player.identifiers ?? []);
        const discordId = getDiscordId(player.identifiers ?? []);

        let discordDetails = null;
        if (discordId) {
          const fetchedDiscord = await getDiscordDetails(discordId);
          if (fetchedDiscord) {
            discordDetails = {
              discordId: fetchedDiscord.id,
              usernameDiscord: fetchedDiscord.username,
              discordPhoto: fetchedDiscord.avatarUrl
            };
          }
        }

        return {
          id: player.id ?? '',
          name: player.name ?? 'Unknown',
          ping: player.ping ?? 0,
          steamProfileUrl,
          discordDetails
        };
      }) ?? []
    );

    res.json({ playerlist });
    await writeLog(`[GET /playerlist] Response sent, total players: ${playerlist.length}`);
  } catch (error) {
    await writeLog(`[GET /playerlist] Error: ${error.message}`);
    res.status(503).json({
      error: 'Service temporarily unavailable',
      message: error.message
    });
  }
});

app.listen(port, () => {
  // Log ke Discord pun
  writeLog(`Server running on http://localhost:${port}`)
    .then(() => console.log(`Server is running on http://localhost:${port}`))
    .catch((err) => console.error('Failed to send startup log to Discord:', err.message));
});
