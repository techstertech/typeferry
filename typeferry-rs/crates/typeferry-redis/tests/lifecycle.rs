//! Run against an owned disposable Redis with scripts/run-with-redis.sh.

use redis::AsyncCommands;
use typeferry_redis::RedisTransport;
use typeferry_runtime::{Server, ServerOptions};

#[tokio::test]
#[ignore = "requires an owned disposable Redis instance through REDIS_URL"]
async fn close_removes_only_its_own_client_key_and_server_membership() {
    let url = std::env::var("REDIS_URL").expect("provide disposable REDIS_URL");
    let server = Server::new(ServerOptions::default());
    let other_server = Server::new(ServerOptions::default());
    let own_key = format!("typeferry:clients:{}", server.uuid);
    let other_key = format!("typeferry:clients:{}", other_server.uuid);
    let own_users_key = format!("typeferry:users:{}", server.uuid);
    let client = redis::Client::open(url.as_str()).unwrap();
    let mut connection = client.get_multiplexed_async_connection().await.unwrap();
    let _: () = redis::pipe()
        .sadd("typeferry:servers", &[&server.uuid, &other_server.uuid])
        .ignore()
        .sadd(&own_key, "own-client")
        .ignore()
        .sadd(&other_key, "other-client")
        .ignore()
        .sadd(&own_users_key, "existing-user")
        .ignore()
        .query_async(&mut connection)
        .await
        .unwrap();
    let transport = RedisTransport::new(server.clone(), url);

    transport.connect().await.unwrap();
    transport.close().await;
    transport.close().await;

    let own_exists: bool = connection.exists(&own_key).await.unwrap();
    let own_member: bool = connection
        .sismember("typeferry:servers", &server.uuid)
        .await
        .unwrap();
    let other_member: bool = connection
        .sismember("typeferry:servers", &other_server.uuid)
        .await
        .unwrap();
    let other_clients: Vec<String> = connection.smembers(&other_key).await.unwrap();
    let own_users: Vec<String> = connection.smembers(&own_users_key).await.unwrap();

    assert!(!own_exists);
    assert!(!own_member);
    assert!(other_member);
    assert_eq!(other_clients, ["other-client"]);
    assert_eq!(own_users, ["existing-user"]);

    let _: () = redis::pipe()
        .del(&[own_key, other_key, own_users_key])
        .ignore()
        .srem("typeferry:servers", &[&server.uuid, &other_server.uuid])
        .ignore()
        .query_async(&mut connection)
        .await
        .unwrap();
}
