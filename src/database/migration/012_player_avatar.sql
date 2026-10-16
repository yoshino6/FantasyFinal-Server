-- 头像由认证接口验证并转码为 256×256 JPEG 后保存，data URL 上限为 65535 字节。
-- 自动启动迁移在 bootstrap.ts 中处理重复字段，此文件用于手动迁移旧库。
ALTER TABLE players ADD COLUMN avatar_data_url TEXT NULL AFTER qq_nickname;
