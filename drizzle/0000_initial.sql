CREATE TABLE `audit_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` char(36),
	`kind` varchar(32) NOT NULL,
	`meta` json,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_profile` (
	`user_id` char(36) NOT NULL,
	`name` varchar(32) NOT NULL,
	`icon_id` varchar(64) NOT NULL,
	`guild_id` char(36),
	`level` int NOT NULL DEFAULT 1,
	`current_exp` bigint NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_profile_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `uq_profile_name` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `user_refresh_token_log` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`device_id` varchar(64) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`action` varchar(16) NOT NULL,
	`at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`ip` varchar(45),
	`user_agent` varchar(255),
	CONSTRAINT `user_refresh_token_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_refresh_tokens` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`device_id` varchar(64) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`issued_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_used_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expires_at` datetime NOT NULL,
	`is_revoked` tinyint NOT NULL DEFAULT 0,
	`ip` varchar(45),
	`user_agent` varchar(255),
	CONSTRAINT `user_refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_urt_user_device` UNIQUE(`user_id`,`device_id`)
);
--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`session_id` varchar(64) NOT NULL,
	`user_id` char(36) NOT NULL,
	`device_id` varchar(64) NOT NULL,
	`room` varchar(64) NOT NULL,
	`connected_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_heartbeat_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`disconnected_at` datetime,
	`ip` varchar(45),
	`user_agent` varchar(255),
	CONSTRAINT `user_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_session` UNIQUE(`session_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`email` varchar(255) NOT NULL,
	`username` varchar(32) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`is_verified` tinyint NOT NULL DEFAULT 0,
	`failed_logins` int NOT NULL DEFAULT 0,
	`locked_until` datetime,
	`is_banned` tinyint NOT NULL DEFAULT 0,
	`ban_reason` varchar(255),
	`ban_expires_at` datetime,
	`chat_muted_until` datetime,
	`chat_mute_reason` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`last_login_at` datetime,
	`is_guest` tinyint NOT NULL DEFAULT 0,
	`deletion_requested_at` datetime,
	`deletion_scheduled_at` datetime,
	`password_changed_at` datetime,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_users_email` UNIQUE(`email`),
	CONSTRAINT `uq_users_username` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE TABLE `user_character_capacity` (
	`user_id` char(36) NOT NULL,
	`bag_capacity` int NOT NULL DEFAULT 100,
	`storage_capacity` int NOT NULL DEFAULT 500,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_character_capacity_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_characters` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_uid` char(26) NOT NULL,
	`user_id` char(36) NOT NULL,
	`character_id` varchar(64) NOT NULL,
	`stars` tinyint NOT NULL DEFAULT 1,
	`level` smallint NOT NULL DEFAULT 1,
	`current_exp` bigint NOT NULL DEFAULT 0,
	`awakening_index` tinyint NOT NULL DEFAULT 0,
	`skill_levels` json,
	`locked` tinyint NOT NULL DEFAULT 0,
	`favorite` tinyint NOT NULL DEFAULT 0,
	`location` enum('BAG','STORAGE') NOT NULL DEFAULT 'BAG',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_characters_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_uc_public_uid` UNIQUE(`public_uid`)
);
--> statement-breakpoint
CREATE TABLE `user_currencies` (
	`user_id` char(36) NOT NULL,
	`currency_id` varchar(64) NOT NULL,
	`amount` bigint NOT NULL DEFAULT 0,
	`last_tick_at` datetime,
	CONSTRAINT `user_currencies_user_id_currency_id_pk` PRIMARY KEY(`user_id`,`currency_id`)
);
--> statement-breakpoint
CREATE TABLE `user_rune_capacity` (
	`user_id` char(36) NOT NULL,
	`rune_capacity` int NOT NULL DEFAULT 200,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_rune_capacity_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_runes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_uid` char(26) NOT NULL,
	`user_id` char(36) NOT NULL,
	`set_id` varchar(64) NOT NULL,
	`slot` tinyint NOT NULL,
	`tier` tinyint NOT NULL,
	`variant` varchar(32) NOT NULL,
	`quality` tinyint NOT NULL,
	`level` tinyint NOT NULL DEFAULT 0,
	`main_stat_type` varchar(32) NOT NULL,
	`main_stat_value` int NOT NULL DEFAULT 0,
	`substats` json,
	`origin` varchar(32),
	`locked` tinyint NOT NULL DEFAULT 0,
	`favorite` tinyint NOT NULL DEFAULT 0,
	`equipped_to_uid` char(26),
	`equipped_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_runes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ur_public_uid` UNIQUE(`public_uid`),
	CONSTRAINT `uq_ur_equipped_char_slot` UNIQUE(`equipped_to_uid`,`slot`)
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`channel` int NOT NULL,
	`user_id` char(36) NOT NULL,
	`nickname` varchar(32) NOT NULL,
	`message` varchar(300) NOT NULL,
	`original_message` varchar(300),
	`icon_id` varchar(64),
	`level` int NOT NULL DEFAULT 1,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `chat_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pve_battles` (
	`id` char(26) NOT NULL,
	`user_id` char(36) NOT NULL,
	`region_id` varchar(64) NOT NULL,
	`stage_id` varchar(64) NOT NULL,
	`difficulty` enum('Easy','Normal','Hard','Hell') NOT NULL,
	`status` enum('TICKET','STARTED','VICTORY','DEFEAT','EXPIRED') NOT NULL DEFAULT 'TICKET',
	`currency_id` varchar(64),
	`energy_spent` int NOT NULL DEFAULT 0,
	`battle_id` char(26),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`started_at` datetime,
	`finished_at` datetime,
	`result` json,
	CONSTRAINT `pve_battles_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_pve_battle_id` UNIQUE(`battle_id`)
);
--> statement-breakpoint
CREATE TABLE `user_building_inventory` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`buildable_id` varchar(64) NOT NULL,
	`count` int unsigned NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_building_inventory_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ubi_user_buildable` UNIQUE(`user_id`,`buildable_id`)
);
--> statement-breakpoint
CREATE TABLE `user_home_islands` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`island_id` varchar(64) NOT NULL,
	`unlocked_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_home_islands_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_uhi_user_island` UNIQUE(`user_id`,`island_id`)
);
--> statement-breakpoint
CREATE TABLE `user_home_objects` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`instance_id` varchar(80) NOT NULL,
	`island_id` varchar(64) NOT NULL,
	`definition_id` varchar(64) NOT NULL,
	`template_instance_id` varchar(80),
	`state` enum('ACTIVE','REMOVED') NOT NULL DEFAULT 'ACTIVE',
	`origin_x` int NOT NULL DEFAULT 0,
	`origin_z` int NOT NULL DEFAULT 0,
	`yaw_degrees` float NOT NULL DEFAULT 0,
	`is_template_object` tinyint NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_home_objects_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_uho_user_instance` UNIQUE(`user_id`,`instance_id`),
	CONSTRAINT `uq_uho_user_template` UNIQUE(`user_id`,`template_instance_id`)
);
--> statement-breakpoint
CREATE TABLE `user_home_prefs` (
	`user_id` char(36) NOT NULL,
	`selected_island_id` varchar(64),
	`revision` bigint NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_home_prefs_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_home_production` (
	`user_id` char(36) NOT NULL,
	`instance_id` varchar(80) NOT NULL,
	`island_id` varchar(64) NOT NULL,
	`buildable_id` varchar(64) NOT NULL,
	`since_unix` bigint NOT NULL DEFAULT 0,
	`units_json` json,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_home_production_user_id_instance_id_pk` PRIMARY KEY(`user_id`,`instance_id`)
);
--> statement-breakpoint
CREATE TABLE `user_iap_transactions` (
	`transaction_key` char(64) NOT NULL,
	`store` varchar(32) NOT NULL,
	`user_id` char(36) NOT NULL,
	`item_id` varchar(64) NOT NULL,
	`product_id` varchar(255) NOT NULL,
	`purchase_id` varchar(64) NOT NULL,
	`order_id` varchar(255),
	`environment` varchar(16) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_iap_transactions_transaction_key` PRIMARY KEY(`transaction_key`)
);
--> statement-breakpoint
CREATE TABLE `user_map_prefs` (
	`user_id` char(36) NOT NULL,
	`last_region_id` varchar(64),
	`last_stage_id` varchar(64),
	`last_difficulty` enum('Easy','Normal','Hard','Hell'),
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_map_prefs_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_shop_counters` (
	`user_id` char(36) NOT NULL,
	`item_id` varchar(64) NOT NULL,
	`window_key` varchar(32) NOT NULL,
	`count` int NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_shop_counters_user_id_item_id_window_key_pk` PRIMARY KEY(`user_id`,`item_id`,`window_key`)
);
--> statement-breakpoint
CREATE TABLE `user_shop_purchases` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` char(36) NOT NULL,
	`item_id` varchar(64) NOT NULL,
	`window_key` varchar(32) NOT NULL,
	`currency_id` varchar(64),
	`price` int NOT NULL DEFAULT 0,
	`first_purchase` tinyint NOT NULL DEFAULT 0,
	`grants` json,
	`purchase_id` varchar(64),
	`response` json,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_shop_purchases_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_usp_user_purchase` UNIQUE(`user_id`,`purchase_id`)
);
--> statement-breakpoint
CREATE TABLE `user_stage_progress` (
	`user_id` char(36) NOT NULL,
	`region_id` varchar(64) NOT NULL,
	`stage_id` varchar(64) NOT NULL,
	`difficulty` enum('Easy','Normal','Hard','Hell') NOT NULL,
	`first_clear_at` datetime,
	`best_clear_ms` int,
	`clears` int NOT NULL DEFAULT 0,
	`last_played_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_stage_progress_user_id_region_id_stage_id_difficulty_pk` PRIMARY KEY(`user_id`,`region_id`,`stage_id`,`difficulty`)
);
--> statement-breakpoint
CREATE TABLE `user_summon_counters` (
	`user_id` char(36) NOT NULL,
	`scroll_id` varchar(64) NOT NULL,
	`summons` int NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_summon_counters_user_id_scroll_id_pk` PRIMARY KEY(`user_id`,`scroll_id`)
);
--> statement-breakpoint
CREATE TABLE `arena_battles` (
	`battle_id` char(26) NOT NULL,
	`attacker_id` char(36) NOT NULL,
	`defender_id` char(36),
	`npc_id` varchar(64),
	`attacker_rating_before` int NOT NULL,
	`rating_delta` int NOT NULL DEFAULT 0,
	`defender_delta` int NOT NULL DEFAULT 0,
	`result` enum('win','loss'),
	`rewards_granted` tinyint NOT NULL DEFAULT 0,
	`result_json` json,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`finished_at` datetime,
	CONSTRAINT `arena_battles_battle_id` PRIMARY KEY(`battle_id`)
);
--> statement-breakpoint
CREATE TABLE `arena_profiles` (
	`user_id` char(36) NOT NULL,
	`public_id` char(16) NOT NULL,
	`rating` int NOT NULL DEFAULT 1000,
	`wins` int NOT NULL DEFAULT 0,
	`losses` int NOT NULL DEFAULT 0,
	`defense_wins` int NOT NULL DEFAULT 0,
	`defense_losses` int NOT NULL DEFAULT 0,
	`defense_json` text,
	`opponents_json` text,
	`opponents_refreshed_at` datetime,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	`season` int NOT NULL DEFAULT 0,
	`season_battles` int NOT NULL DEFAULT 0,
	`last_season_json` text,
	`season_result_pending` tinyint NOT NULL DEFAULT 0,
	CONSTRAINT `arena_profiles_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `uq_arena_public_id` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `guild_activity` (
	`guild_id` char(36) NOT NULL,
	`week_key` varchar(16) NOT NULL,
	`user_id` char(36) NOT NULL,
	`points` int NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `guild_activity_guild_id_week_key_user_id_pk` PRIMARY KEY(`guild_id`,`week_key`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `guild_chat_messages` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`guild_id` char(36) NOT NULL,
	`user_id` char(36),
	`kind` enum('user','system') NOT NULL DEFAULT 'user',
	`nickname` varchar(32) NOT NULL,
	`icon_id` varchar(64),
	`level` int NOT NULL DEFAULT 1,
	`message` varchar(300) NOT NULL,
	`original_message` varchar(300),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `guild_chat_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `guild_chest_claims` (
	`user_id` char(36) NOT NULL,
	`week_key` varchar(16) NOT NULL,
	`chest_id` varchar(64) NOT NULL,
	`guild_id` char(36) NOT NULL,
	`claimed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `guild_chest_claims_user_id_week_key_chest_id_pk` PRIMARY KEY(`user_id`,`week_key`,`chest_id`)
);
--> statement-breakpoint
CREATE TABLE `guild_join_requests` (
	`id` char(16) NOT NULL,
	`guild_id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `guild_join_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_guild_request_guild_user` UNIQUE(`guild_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `guild_members` (
	`user_id` char(36) NOT NULL,
	`guild_id` char(36) NOT NULL,
	`public_id` char(16) NOT NULL,
	`role` enum('leader','officer','member') NOT NULL DEFAULT 'member',
	`joined_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `guild_members_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `uq_guild_member_public_id` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `guild_quest_progress` (
	`user_id` char(36) NOT NULL,
	`quest_id` varchar(64) NOT NULL,
	`period_key` varchar(16) NOT NULL,
	`progress` int NOT NULL DEFAULT 0,
	`claimed_at` datetime,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `guild_quest_progress_user_id_quest_id_period_key_pk` PRIMARY KEY(`user_id`,`quest_id`,`period_key`)
);
--> statement-breakpoint
CREATE TABLE `guilds` (
	`id` char(36) NOT NULL,
	`name` varchar(32) NOT NULL,
	`name_key` varchar(32) NOT NULL,
	`description` varchar(255) NOT NULL DEFAULT '',
	`notice` varchar(255) NOT NULL DEFAULT '',
	`icon_id` varchar(64) NOT NULL,
	`tags_json` text,
	`join_type` enum('open','approval') NOT NULL DEFAULT 'open',
	`min_level` int NOT NULL DEFAULT 1,
	`member_count` int NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `guilds_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_guild_name_key` UNIQUE(`name_key`)
);
--> statement-breakpoint
CREATE TABLE `mail_broadcasts` (
	`id` char(16) NOT NULL,
	`category` varchar(16) NOT NULL DEFAULT 'gm',
	`sender` varchar(64) NOT NULL DEFAULT '',
	`title` varchar(120) NOT NULL DEFAULT '',
	`body` text,
	`title_key` varchar(64),
	`body_key` varchar(64),
	`params_json` text,
	`attachments_json` text,
	`include_new_players` tinyint NOT NULL DEFAULT 0,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expires_at` datetime,
	CONSTRAINT `mail_broadcasts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_mail` (
	`id` char(16) NOT NULL,
	`user_id` char(36) NOT NULL,
	`category` varchar(16) NOT NULL DEFAULT 'system',
	`sender` varchar(64) NOT NULL DEFAULT '',
	`title` varchar(120) NOT NULL DEFAULT '',
	`body` text,
	`title_key` varchar(64),
	`body_key` varchar(64),
	`params_json` text,
	`attachments_json` text,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expires_at` datetime,
	`read_at` datetime,
	`claimed_at` datetime,
	CONSTRAINT `user_mail_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_mail_receipts` (
	`user_id` char(36) NOT NULL,
	`receipt_key` varchar(96) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_mail_receipts_user_id_receipt_key_pk` PRIMARY KEY(`user_id`,`receipt_key`)
);
--> statement-breakpoint
CREATE TABLE `user_story_active` (
	`user_id` char(36) NOT NULL,
	`dialogue_id` varchar(64) NOT NULL,
	`step` int NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_story_active_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_story_progress` (
	`user_id` char(36) NOT NULL,
	`dialogue_id` varchar(64) NOT NULL,
	`skipped` tinyint NOT NULL DEFAULT 0,
	`times` int NOT NULL DEFAULT 1,
	`completed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_story_progress_user_id_dialogue_id_pk` PRIMARY KEY(`user_id`,`dialogue_id`)
);
--> statement-breakpoint
CREATE TABLE `user_mission_progress` (
	`user_id` char(36) NOT NULL,
	`mission_id` varchar(64) NOT NULL,
	`period_key` varchar(16) NOT NULL,
	`progress` int NOT NULL DEFAULT 0,
	`claimed_at` datetime,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_mission_progress_user_id_mission_id_period_key_pk` PRIMARY KEY(`user_id`,`mission_id`,`period_key`)
);
--> statement-breakpoint
CREATE TABLE `user_tower_progress` (
	`user_id` char(36) NOT NULL,
	`region_id` varchar(64) NOT NULL,
	`season_key` varchar(16) NOT NULL,
	`cleared_floors` int NOT NULL DEFAULT 0,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_tower_progress_user_id_region_id_season_key_pk` PRIMARY KEY(`user_id`,`region_id`,`season_key`)
);
--> statement-breakpoint
CREATE TABLE `user_attendance` (
	`user_id` char(36) NOT NULL,
	`claimed_days` int NOT NULL DEFAULT 0,
	`last_claim_day` varchar(10),
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_attendance_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `player_reports` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`reporter_user_id` char(36),
	`target_user_id` char(36) NOT NULL,
	`target_name` varchar(64) NOT NULL DEFAULT '',
	`category` varchar(16) NOT NULL,
	`comment` varchar(300) NOT NULL DEFAULT '',
	`source` varchar(16) NOT NULL,
	`source_ref` varchar(36),
	`message_id` bigint,
	`message_text` varchar(300),
	`context_json` json,
	`status` varchar(12) NOT NULL DEFAULT 'open',
	`open_slot` tinyint,
	`resolution_action` varchar(16),
	`resolution_note` varchar(255),
	`handled_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `player_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_reports_open_pair` UNIQUE(`reporter_user_id`,`target_user_id`,`open_slot`)
);
--> statement-breakpoint
CREATE TABLE `server_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`level` varchar(8) NOT NULL,
	`scope` varchar(48) NOT NULL DEFAULT '',
	`message` varchar(2000) NOT NULL,
	`details` text,
	`user_id` char(36),
	`room` varchar(32),
	`repeats` int NOT NULL DEFAULT 1,
	`pid` int NOT NULL DEFAULT 0,
	CONSTRAINT `server_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_request_results` (
	`user_id` char(36) NOT NULL,
	`request_id` varchar(64) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`response` json,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_request_results_user_id_request_id_pk` PRIMARY KEY(`user_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `direct_messages` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`conversation_key` varchar(73) NOT NULL,
	`sender_id` char(36) NOT NULL,
	`recipient_id` char(36) NOT NULL,
	`message` varchar(300) NOT NULL,
	`original_message` varchar(300),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `direct_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dm_threads` (
	`user_id` char(36) NOT NULL,
	`peer_id` char(36) NOT NULL,
	`last_message_id` bigint unsigned NOT NULL DEFAULT 0,
	`last_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`unread` int NOT NULL DEFAULT 0,
	`last_read_id` bigint unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `dm_threads_user_id_peer_id_pk` PRIMARY KEY(`user_id`,`peer_id`)
);
--> statement-breakpoint
CREATE TABLE `friendly_matches` (
	`id` char(26) NOT NULL,
	`challenger_id` char(36) NOT NULL,
	`target_id` char(36) NOT NULL,
	`status` enum('pending','accepted','declined','cancelled','expired','finished','aborted') NOT NULL DEFAULT 'pending',
	`room_id` varchar(64),
	`winner_id` char(36),
	`finished_reason` varchar(32),
	`result_json` json,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expires_at` datetime NOT NULL,
	`responded_at` datetime,
	`finished_at` datetime,
	CONSTRAINT `friendly_matches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `friendships` (
	`id` char(26) NOT NULL,
	`pair_key` varchar(73) NOT NULL,
	`requester_id` char(36) NOT NULL,
	`addressee_id` char(36) NOT NULL,
	`status` enum('pending','accepted') NOT NULL DEFAULT 'pending',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`responded_at` datetime,
	CONSTRAINT `friendships_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_friend_pair` UNIQUE(`pair_key`)
);
--> statement-breakpoint
CREATE TABLE `user_blocks` (
	`blocker_id` char(36) NOT NULL,
	`blocked_id` char(36) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `user_blocks_blocker_id_blocked_id_pk` PRIMARY KEY(`blocker_id`,`blocked_id`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD CONSTRAINT `audit_events_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_profile` ADD CONSTRAINT `user_profile_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_refresh_tokens` ADD CONSTRAINT `user_refresh_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_character_capacity` ADD CONSTRAINT `user_character_capacity_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_characters` ADD CONSTRAINT `user_characters_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_currencies` ADD CONSTRAINT `user_currencies_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_rune_capacity` ADD CONSTRAINT `user_rune_capacity_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_runes` ADD CONSTRAINT `user_runes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_runes` ADD CONSTRAINT `user_runes_equipped_to_uid_user_characters_public_uid_fk` FOREIGN KEY (`equipped_to_uid`) REFERENCES `user_characters`(`public_uid`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD CONSTRAINT `chat_messages_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pve_battles` ADD CONSTRAINT `pve_battles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_building_inventory` ADD CONSTRAINT `user_building_inventory_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_home_islands` ADD CONSTRAINT `user_home_islands_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_home_objects` ADD CONSTRAINT `user_home_objects_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_home_prefs` ADD CONSTRAINT `user_home_prefs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_home_production` ADD CONSTRAINT `user_home_production_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_map_prefs` ADD CONSTRAINT `user_map_prefs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_shop_counters` ADD CONSTRAINT `user_shop_counters_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_shop_purchases` ADD CONSTRAINT `user_shop_purchases_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_stage_progress` ADD CONSTRAINT `user_stage_progress_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_summon_counters` ADD CONSTRAINT `user_summon_counters_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `arena_battles` ADD CONSTRAINT `arena_battles_attacker_id_users_id_fk` FOREIGN KEY (`attacker_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `arena_battles` ADD CONSTRAINT `arena_battles_defender_id_users_id_fk` FOREIGN KEY (`defender_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `arena_profiles` ADD CONSTRAINT `arena_profiles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_activity` ADD CONSTRAINT `guild_activity_guild_id_guilds_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_activity` ADD CONSTRAINT `guild_activity_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_chat_messages` ADD CONSTRAINT `guild_chat_messages_guild_id_guilds_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_chat_messages` ADD CONSTRAINT `guild_chat_messages_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_chest_claims` ADD CONSTRAINT `guild_chest_claims_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_join_requests` ADD CONSTRAINT `guild_join_requests_guild_id_guilds_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_join_requests` ADD CONSTRAINT `guild_join_requests_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_members` ADD CONSTRAINT `guild_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_members` ADD CONSTRAINT `guild_members_guild_id_guilds_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `guild_quest_progress` ADD CONSTRAINT `guild_quest_progress_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_mail` ADD CONSTRAINT `user_mail_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_mail_receipts` ADD CONSTRAINT `user_mail_receipts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_story_active` ADD CONSTRAINT `user_story_active_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_story_progress` ADD CONSTRAINT `user_story_progress_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_mission_progress` ADD CONSTRAINT `user_mission_progress_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_tower_progress` ADD CONSTRAINT `user_tower_progress_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_attendance` ADD CONSTRAINT `user_attendance_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `player_reports` ADD CONSTRAINT `player_reports_reporter_user_id_users_id_fk` FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `player_reports` ADD CONSTRAINT `player_reports_target_user_id_users_id_fk` FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_request_results` ADD CONSTRAINT `user_request_results_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `direct_messages` ADD CONSTRAINT `direct_messages_sender_id_users_id_fk` FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `direct_messages` ADD CONSTRAINT `direct_messages_recipient_id_users_id_fk` FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dm_threads` ADD CONSTRAINT `dm_threads_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dm_threads` ADD CONSTRAINT `dm_threads_peer_id_users_id_fk` FOREIGN KEY (`peer_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `friendly_matches` ADD CONSTRAINT `friendly_matches_challenger_id_users_id_fk` FOREIGN KEY (`challenger_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `friendly_matches` ADD CONSTRAINT `friendly_matches_target_id_users_id_fk` FOREIGN KEY (`target_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `friendships` ADD CONSTRAINT `friendships_requester_id_users_id_fk` FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `friendships` ADD CONSTRAINT `friendships_addressee_id_users_id_fk` FOREIGN KEY (`addressee_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_blocks` ADD CONSTRAINT `user_blocks_blocker_id_users_id_fk` FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_blocks` ADD CONSTRAINT `user_blocks_blocked_id_users_id_fk` FOREIGN KEY (`blocked_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_audit_user` ON `audit_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_profile_guild` ON `user_profile` (`guild_id`);--> statement-breakpoint
CREATE INDEX `idx_profile_level` ON `user_profile` (`level`,`current_exp`);--> statement-breakpoint
CREATE INDEX `idx_urtl_user` ON `user_refresh_token_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_urtl_at` ON `user_refresh_token_log` (`at`);--> statement-breakpoint
CREATE INDEX `idx_urt_expiry` ON `user_refresh_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_urt_refresh_lookup` ON `user_refresh_tokens` (`user_id`,`device_id`,`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_user_active` ON `user_sessions` (`user_id`,`disconnected_at`);--> statement-breakpoint
CREATE INDEX `idx_online` ON `user_sessions` (`last_heartbeat_at`,`disconnected_at`);--> statement-breakpoint
CREATE INDEX `idx_users_last_login` ON `users` (`last_login_at`);--> statement-breakpoint
CREATE INDEX `idx_users_ban` ON `users` (`is_banned`,`ban_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_users_deletion_scheduled` ON `users` (`deletion_scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_uc_user_char` ON `user_characters` (`user_id`,`character_id`);--> statement-breakpoint
CREATE INDEX `idx_uc_user_loc_id` ON `user_characters` (`user_id`,`location`,`id`);--> statement-breakpoint
CREATE INDEX `idx_ur_user_set` ON `user_runes` (`user_id`,`set_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_ur_user_slot` ON `user_runes` (`user_id`,`slot`,`id`);--> statement-breakpoint
CREATE INDEX `idx_chat_channel_time` ON `chat_messages` (`channel`,`id`);--> statement-breakpoint
CREATE INDEX `idx_pve_user_status` ON `pve_battles` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_uho_user_island` ON `user_home_objects` (`user_id`,`island_id`);--> statement-breakpoint
CREATE INDEX `idx_uiap_user_time` ON `user_iap_transactions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_usp_user_time` ON `user_shop_purchases` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_arena_battle_attacker` ON `arena_battles` (`attacker_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_arena_battle_defender` ON `arena_battles` (`defender_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_arena_rating` ON `arena_profiles` (`rating`);--> statement-breakpoint
CREATE INDEX `idx_arena_season` ON `arena_profiles` (`season`);--> statement-breakpoint
CREATE INDEX `idx_guild_chat_guild` ON `guild_chat_messages` (`guild_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_guild_request_user` ON `guild_join_requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_guild_member_guild` ON `guild_members` (`guild_id`,`role`);--> statement-breakpoint
CREATE INDEX `idx_guild_quest_user_period` ON `guild_quest_progress` (`user_id`,`period_key`);--> statement-breakpoint
CREATE INDEX `idx_guild_member_count` ON `guilds` (`member_count`);--> statement-breakpoint
CREATE INDEX `idx_mail_broadcast_created` ON `mail_broadcasts` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_user_mail_user_created` ON `user_mail` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_mission_user_period` ON `user_mission_progress` (`user_id`,`period_key`);--> statement-breakpoint
CREATE INDEX `idx_tower_region_season` ON `user_tower_progress` (`region_id`,`season_key`,`cleared_floors`);--> statement-breakpoint
CREATE INDEX `idx_reports_status` ON `player_reports` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_reports_target` ON `player_reports` (`target_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_reports_reporter` ON `player_reports` (`reporter_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_server_logs_created` ON `server_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_server_logs_level` ON `server_logs` (`level`,`id`);--> statement-breakpoint
CREATE INDEX `idx_server_logs_scope` ON `server_logs` (`scope`,`id`);--> statement-breakpoint
CREATE INDEX `idx_request_results_created` ON `user_request_results` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_dm_conversation` ON `direct_messages` (`conversation_key`,`id`);--> statement-breakpoint
CREATE INDEX `idx_dm_thread_recent` ON `dm_threads` (`user_id`,`last_at`);--> statement-breakpoint
CREATE INDEX `idx_fm_challenger` ON `friendly_matches` (`challenger_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_fm_target` ON `friendly_matches` (`target_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_friend_requester` ON `friendships` (`requester_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_friend_addressee` ON `friendships` (`addressee_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_block_blocked` ON `user_blocks` (`blocked_id`);