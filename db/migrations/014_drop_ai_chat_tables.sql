-- AIチャットの会話履歴はクライアント (localStorage) 保持に変更したため、サーバー側の保存テーブルを廃止
DROP TABLE IF EXISTS ai_messages;
DROP TABLE IF EXISTS ai_threads;
