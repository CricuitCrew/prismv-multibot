const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder
} = require("discord.js");
const fs = require("fs");
const path = require("path");

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"), "utf8")
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once("ready", () => {
  console.log(`✅ Bot avviato come ${client.user.tag}`);
});

/* ======================================================
   UTILITIES
====================================================== */

function hasAny(member, roles) {
  return roles.some(r => member.roles.cache.has(r));
}

function ensureRole(member, roleId) {
  if (!member.roles.cache.has(roleId)) {
    return member.roles.add(roleId).catch(() => {});
  }
}

function removeRole(member, roleId) {
  if (member.roles.cache.has(roleId)) {
    return member.roles.remove(roleId).catch(() => {});
  }
}

/* ======================================================
   RUOLI COMBINATI + TRIGGER DOMANDE SOLO SU HW ADDED
====================================================== */

// piccolo lock in RAM per evitare doppie esecuzioni ravvicinate
const hwLock = new Map(); // userId -> timestamp
const welcomeLock = new Map(); // userId -> timestamp (anti doppio msg)

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  if (newMember.guild.id !== config.guildId) return;

  const R = config.roles;

  // ---- 1) Ruoli derivati (sempre, perché deve correggere lo stato) ----
  const hasPC = newMember.roles.cache.has(R.PC);
  const hasConsole = hasAny(newMember, [R.PS5, R.XBOX]);
  const hasACC = newMember.roles.cache.has(R.ACC);
  const hasLMU = newMember.roles.cache.has(R.LMU);

  // ACC
  if (hasACC && hasPC) ensureRole(newMember, R.ACC_PC);
  else removeRole(newMember, R.ACC_PC);

  if (hasACC && hasConsole) ensureRole(newMember, R.ACC_CONSOLE);
  else removeRole(newMember, R.ACC_CONSOLE);

  // LMU
  if (hasLMU && hasPC) ensureRole(newMember, R.LMU_PC);
  else removeRole(newMember, R.LMU_PC);

  if (hasLMU && hasConsole) ensureRole(newMember, R.LMU_CONSOLE);
  else removeRole(newMember, R.LMU_CONSOLE);

  // ---- 1.5) WELCOME: quando viene aggiunto il ruolo "new user" ----
  const NEW_USER_ROLE_ID = "1258822290385276978";
  const GAME_SELECT_CHANNEL_ID = "1304790351042711636";

  const addedNewUser =
    !oldMember.roles.cache.has(NEW_USER_ROLE_ID) &&
    newMember.roles.cache.has(NEW_USER_ROLE_ID);

  if (addedNewUser) {
    // anti doppio messaggio in caso di update a catena
    const lastW = welcomeLock.get(newMember.id) || 0;
    const nowW = Date.now();
    if (nowW - lastW > 5000) {
      welcomeLock.set(newMember.id, nowW);

      setTimeout(async () => {
        try {
          const ch = newMember.guild.channels.cache.get(GAME_SELECT_CHANNEL_ID);
          if (!ch) return;

          const msg =
`🇮🇹 Benvenuto su WeAreSimRacing!
Sim racing PC & Console → vai su <#${GAME_SELECT_CHANNEL_ID}> per scegliere gioco e piattaforma e sbloccare i canali.

🇬🇧 Welcome to WeAreSimRacing!
Sim racing PC & Console → go to <#${GAME_SELECT_CHANNEL_ID}> to select your game & platform and unlock channels.`;

          await ch.send({ content: msg });
        } catch (e) {
          console.error("WELCOME ERROR:", e);
        }
      }, 1000);

      setTimeout(() => welcomeLock.delete(newMember.id), 15000);
    }
  }

  // ---- 2) Domande: SOLO se è stato aggiunto PC/PS5/XBOX in questo update ----
  const added = {
    pc: !oldMember.roles.cache.has(R.PC) && newMember.roles.cache.has(R.PC),
    ps5: !oldMember.roles.cache.has(R.PS5) && newMember.roles.cache.has(R.PS5),
    xbox: !oldMember.roles.cache.has(R.XBOX) && newMember.roles.cache.has(R.XBOX)
  };

  if (!added.pc && !added.ps5 && !added.xbox) return;

  // lock anti-doppio trigger (es: update a catena)
  const last = hwLock.get(newMember.id) || 0;
  const now = Date.now();
  if (now - last < 3000) return; // 3s di finestra
  hwLock.set(newMember.id, now);

  try {
    await ensurePrivateChannelAndAsk(newMember, added);
  } finally {
    // non serve tenere il lock a lungo
    setTimeout(() => hwLock.delete(newMember.id), 5000);
  }
});

/* ======================================================
   CANALE PRIVATO ID HARDWARE (no file locali)
====================================================== */

async function ensurePrivateChannelAndAsk(member, added) {
  const guild = member.guild;
  const channelName = `id-${member.id}`;

  // Cerca canale già esistente nella categoria
  let channel = guild.channels.cache.find(
    c => c.name === channelName && c.parentId === config.privateCategoryId
  );

  // Crea se non esiste
  if (!channel) {
    channel = await guild.channels.create({
      name: channelName,
      type: 0, // GuildText
      parent: config.privateCategoryId,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionsBitField.Flags.ViewChannel]
        },
        {
          id: member.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory
          ]
        },
        {
          id: config.adminRoleId,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory
          ]
        }
      ],
      topic: "asked:"
    });
  }

  // Topic come “memoria” per non ripetere domande
  const topic = channel.topic || "asked:";
  const asked = topic.replace("asked:", "").split(",").filter(Boolean);

  let changed = false;

  if (added.pc && !asked.includes("steam")) {
    await channel.send("🔹 **Qual è il tuo ID STEAM?**");
    asked.push("steam");
    changed = true;
  }

  if (added.ps5 && !asked.includes("psn")) {
    await channel.send("🔹 **Qual è il tuo ID PlayStation?**");
    asked.push("psn");
    changed = true;
  }

  if (added.xbox && !asked.includes("xbox")) {
    await channel.send("🔹 **Qual è il tuo ID Xbox?**");
    asked.push("xbox");
    changed = true;
  }

  if (changed) {
    await channel.setTopic(`asked:${asked.join(",")}`).catch(() => {});
  }
}

/* ======================================================
   COMANDO !gara (wizard)
====================================================== */

client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (message.channel.id !== config.garaControlChannelId) return;
  if (!message.member.roles.cache.has(config.adminRoleId)) return;

  if (message.content === "!gara") {
    const ask = async (q) => {
      await message.channel.send(q);
      const collected = await message.channel.awaitMessages({
        max: 1,
        time: 600000,
        filter: m => m.author.id === message.author.id
      });
      return collected.first().content;
    };

    const channelMention = await ask("📌 **Tagga il canale dove pubblicare l'embed**");
    const targetChannelId = channelMention.replace(/[<#>]/g, "");
    const targetChannel = message.guild.channels.cache.get(targetChannelId);

    if (!targetChannel) {
      await message.channel.send("❌ Canale non valido.");
      return;
    }

    const title = await ask("📝 **Inserisci il titolo dell'embed**");
    const body = await ask("📄 **Inserisci il corpo del messaggio**");

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(body)
      .addFields(
        { name: "Iscritti:", value: "-", inline: false },
        { name: "Annullato:", value: "-", inline: false }
      )
      .setColor(0x00ff00);

    const embedMessage = await targetChannel.send({ embeds: [embed] });
    await embedMessage.react(config.reactionEmoji);

    await message.channel.send("✅ Embed gara creato.");
  }
});

/* ======================================================
   REACTION: Iscritti / Annullato
====================================================== */

async function updateEmbedList(reaction, user, removed = false) {
  const message = reaction.message;
  if (!message.embeds.length) return;

  const embed = EmbedBuilder.from(message.embeds[0]);

  const iscritti = embed.data.fields?.[0]?.value === "-" ? [] : (embed.data.fields?.[0]?.value || "").split("\n");
  const annullato = embed.data.fields?.[1]?.value === "-" ? [] : (embed.data.fields?.[1]?.value || "").split("\n");

  const mention = `<@${user.id}>`;

  if (!removed) {
    if (!iscritti.includes(mention)) iscritti.push(mention);
    const idx = annullato.indexOf(mention);
    if (idx !== -1) annullato.splice(idx, 1);
  } else {
    const idx = iscritti.indexOf(mention);
    if (idx !== -1) iscritti.splice(idx, 1);
    if (!annullato.includes(mention)) annullato.push(mention);
  }

  embed.spliceFields(
    0,
    2,
    { name: "Iscritti:", value: iscritti.length ? iscritti.join("\n") : "-", inline: false },
    { name: "Annullato:", value: annullato.length ? annullato.join("\n") : "-", inline: false }
  );

  await message.edit({ embeds: [embed] });
}

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.emoji.name !== config.reactionEmoji) return;

  await updateEmbedList(reaction, user, false);
});

client.on("messageReactionRemove", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.emoji.name !== config.reactionEmoji) return;

  await updateEmbedList(reaction, user, true);
});

/* ======================================================
   LOGIN
====================================================== */

client.login(config.token);
