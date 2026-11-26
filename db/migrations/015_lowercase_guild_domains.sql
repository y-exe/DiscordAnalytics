-- guild_domains.domain を小文字に統一する。
-- DNS名は大小を区別しないため、招待コード由来 (大文字混じり) のドメインが
-- 小文字化したHost/caddy-ask照合と一致せず、証明書発行・ギルド解決が失敗するため。
-- 重複 (大文字小文字違いの同一ドメイン) があれば先に片方を消す。
DELETE FROM guild_domains a
USING guild_domains b
WHERE lower(a.domain) = lower(b.domain) AND a.domain <> b.domain;
UPDATE guild_domains SET domain = lower(domain) WHERE domain <> lower(domain);
