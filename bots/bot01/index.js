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
   RUOLI COMBINATI
====================================================== */

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  if (newMember.guild.id !== config.guildId) return;

  const R = config.roles;

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

  // CHAT PRIVATA ID HARDWARE
  const hwRoles = [R.PC, R.PS5, R.XBOX];
  const hadHW = hasAny(oldMember, hwRoles);
  const hasHW = hasAny(newMember, hwRoles);

  if (!hadHW && hasHW) {
    await ensurePrivateChannel(newMember);
  }

  if (hadHW && hasHW) {
    await ensurePrivateChannel(newMember);
  }
});

/* ======================================================
   CANALE PRIVATO ID HARDWARE
====================================================== */

async function ensurePrivateChannel(member) {
  const guild = member.guild;
  const channelName = `id-${member.id}`;

  let channel = guild.channels.cache.find(
    c => c.name === channelName && c.parentId === config.privateCategoryId
  );

  if (!channel) {
    channel = await guild.channels.create({
      name: channelName,
      type: 0,
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

  const asked = channel.topic?.replace("asked:", "").split(",").filter(Boolean) || [];
  const roles = member.roles.cache;

  if (roles.has(config.roles.PC) && !asked.includes("steam")) {
    await channel.send("🔹 **Qual è il tuo ID STEAM?**");
    asked.push("steam");
  }

  if (roles.has(config.roles.PS5) && !asked.includes("psn")) {
    await channel.send("🔹 **Qual è il tuo ID PlayStation?**");
    asked.push("psn");
  }

  if (roles.has(config.roles.XBOX) && !asked.includes("xbox")) {
    await channel.send("🔹 **Qual è il tuo ID Xbox?**");
    asked.push("xbox");
  }

  await channel.setTopic(`asked:${asked.join(",")}`);
}

/* ======================================================
   COMANDO !gara
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
      message.channel.send("❌ Canale non valido.");
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
   GESTIONE REACTION ISCRIZIONI
====================================================== */

async function updateEmbedList(reaction, user, removed = false) {
  const message = reaction.message;
  if (!message.embeds.length) return;

  const embed = EmbedBuilder.from(message.embeds[0]);
  const iscritti = embed.data.fields[0].value === "-" ? [] : embed.data.fields[0].value.split("\n");
  const annullato = embed.data.fields[1].value === "-" ? [] : embed.data.fields[1].value.split("\n");
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

  embed.spliceFields(0, 2,
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
