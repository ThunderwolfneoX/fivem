const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp');
const https = require('https');
const NodeCache = require('node-cache');
const fs = require('fs'); // untuk menulis log ke file

const app = express();
const port = 8080;

app.use(cors());

// ----------------------------------------------------------------
// 0. Fungsi penulisan log -> tulis ke log.txt
// ----------------------------------------------------------------
function writeLog(message) {
  const logMessage = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync('log.txt', logMessage, { encoding: 'utf8' });
}

// ----------------------------------------------------------------
// 1. Setup NodeCache (untuk menyimpan data FiveM)
// ----------------------------------------------------------------
// - stdTTL: 60 -> data kadaluarsa otomatis setelah 60 detik (opsional)
// - checkperiod: 120 -> interval pembersihan internal (opsional)
const serverCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Key yang kita pakai untuk menyimpan data di cache
const FIVEM_CACHE_KEY = 'fivemServerData';

// ----------------------------------------------------------------
// 2. Helper Functions (SteamID, Discord, dsb)
// ----------------------------------------------------------------

// Konversi SteamID hex ke decimal
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

// Dapatkan URL Profil Steam
const getSteamProfileUrl = (ids) => {
  const filtered = ids.filter((identifier) => identifier.startsWith('steam:'));
  if (filtered.length > 0) {
    const steamId = hexToDecimal(filtered[0].substring(filtered[0].indexOf(':') + 1));
    return `https://steamcommunity.com/profiles/${steamId}`;
  }
  return null;
};

// Dapatkan Discord ID
const getDiscordId = (ids) => {
  const filtered = ids.filter((identifier) => identifier.startsWith('discord:'));
  if (filtered.length > 0) {
    return filtered[0].substring(filtered[0].indexOf(':') + 1);
  }
  return null;
};

// Ambil data user Discord
const getDiscordDetails = async (discordId) => {
  try {
    // writeLog(`[getDiscordDetails] Fetching data for Discord ID: ${discordId}`);
    const response = await axios.get(`https://discordlookup.mesalytic.moe/v1/user/${discordId}`);
    if (response.data) {
      const { id, username, avatar } = response.data;
      // writeLog(`[getDiscordDetails] Success -> ID: ${id}, username: ${username}`);
      return {
        id,
        username,
        avatarUrl: avatar ? `https://cdn.discordapp.com/avatars/${id}/${avatar.id}` : "https://via.placeholder.com/64"
      };
    }
    writeLog(`[getDiscordDetails] No data found for Discord ID: ${discordId}`);
    return null;
  } catch (error) {
    writeLog(`[getDiscordDetails] Error: ${error.message}`);
    return null;
  }
};

// Ambil ukuran gambar (banner)
async function getImageSize(imageUrl) {
  try {
    writeLog(`[getImageSize] Fetching image size: ${imageUrl}`);
    const response = await axios({
      method: 'get',
      url: imageUrl,
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    const imageBuffer = Buffer.from(response.data, 'binary');
    const metadata = await sharp(imageBuffer).metadata();
    writeLog(`[getImageSize] -> ${metadata.width}x${metadata.height}`);
    return {
      width: metadata.width,
      height: metadata.height
    };
  } catch (error) {
    writeLog(`[getImageSize] Error: ${error.message}`);
    return null;
  }
}

// ----------------------------------------------------------------
// 3. Fungsi utama: ambil data dari FiveM (untuk dijalankan periodik)
// ----------------------------------------------------------------
async function fetchFiveMData() {
  try {
    writeLog(`[fetchFiveMData] Fetching from FiveM...`);
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

    // Request ke FiveM
    const url = 'https://servers-frontend.fivem.net/api/servers/single/4ylb3o';
    const response = await axios.get(url, config);

    if (response.status === 200 && response.data?.Data) {
      // Simpan ke cache
      serverCache.set(FIVEM_CACHE_KEY, response.data.Data);
      writeLog(`[fetchFiveMData] Success -> Data cached`);
    } else {
      writeLog(`[fetchFiveMData] Non-200 status: ${response.status}`);
    }
  } catch (error) {
    // Error jaringan, timeout, dsb
    writeLog(`[fetchFiveMData] Error: ${error.message}`);
  }
}

// ----------------------------------------------------------------
// 4. Jalankan fetchFiveMData secara periodik
// ----------------------------------------------------------------
// -> Agar TIDAK spam endpoint FiveM, kita cukup jalankan ini 1x/30 detik
// -> Interval bisa diubah sesuai kebutuhan (semakin kecil = data lebih fresh, tapi potensi spam).
fetchFiveMData(); // panggil pertama kali saat server mulai
setInterval(fetchFiveMData, 10_000); // setiap 30 detik

// ----------------------------------------------------------------
// 5. Endpoint Express
// ----------------------------------------------------------------

// Health check
app.get('/', (req, res) => {
  writeLog(`[GET /] Health check`);
  res.status(200).json({ status: 'API OK' });
});

// Endpoint serverdetail
app.get('/serverdetail', async (req, res) => {
  writeLog(`[GET /serverdetail] Request received`);
  try {
    // Baca data dari cache
    const serverData = serverCache.get(FIVEM_CACHE_KEY);

    // Jika cache kosong, berarti fetchFiveMData belum berhasil
    if (!serverData) {
      writeLog(`[GET /serverdetail] Cache miss -> No data in cache`);
      return res.status(503).json({
        error: 'No data available',
        message: 'Cache is empty, please try again later.'
      });
    }

    // Ambil banner size (opsional)
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
    writeLog(`[GET /serverdetail] Response sent`);
  } catch (error) {
    writeLog(`[GET /serverdetail] Error: ${error.message}`);
    res.status(503).json({
      error: 'Service temporarily unavailable',
      message: error.message
    });
  }
});

// Endpoint playerlist
app.get('/playerlist', async (req, res) => {
  writeLog(`[GET /playerlist] Request received`);
  try {
    // Baca data dari cache
    const serverData = serverCache.get(FIVEM_CACHE_KEY);
    if (!serverData) {
      writeLog(`[GET /playerlist] Cache miss -> No data in cache`);
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
    writeLog(`[GET /playerlist] Response sent, total players: ${playerlist.length}`);
  } catch (error) {
    writeLog(`[GET /playerlist] Error: ${error.message}`);
    res.status(503).json({
      error: 'Service temporarily unavailable',
      message: error.message
    });
  }
});

// Jalankan server
app.listen(port, () => {
  writeLog(`Server running on http://localhost:${port}`);
  console.log(`Server is running on http://localhost:${port}`);
});
