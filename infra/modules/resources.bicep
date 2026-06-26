targetScope = 'resourceGroup'

param name string
param location string = resourceGroup().location
param tags object = {}

@secure()
param adminPassword string

@secure()
param databaseUrl string = ''

param sqliteUseAzureFiles bool = true

var serviceName = 'web'
var uniqueToken = take(uniqueString(subscription().id, resourceGroup().id, name), 12)
var containerAppName = 'ca-${take(name, 20)}-${take(uniqueToken, 6)}'
var managedEnvironmentName = 'cae-${name}'
var logAnalyticsWorkspaceName = 'log-${name}'
var applicationInsightsName = 'appi-${name}'
var containerRegistryName = 'cr${uniqueToken}'
var containerAppIdentityName = 'id-${name}'
var storageAccountName = 'st${uniqueToken}'
var fileShareName = 'quiz-data'
var environmentStorageName = 'quiz-data'
var sqliteDataPath = '/app/data'
var usePostgres = !empty(databaseUrl)
var useAzureFilesForSqlite = !usePostgres && sqliteUseAzureFiles
var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspace.id
  }
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: containerRegistryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource containerAppIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: containerAppIdentityName
  location: location
  tags: tags
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = if (useAzureFilesForSqlite) {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowSharedKeyAccess: true
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = if (useAzureFilesForSqlite) {
  parent: storageAccount
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = if (useAzureFilesForSqlite) {
  parent: fileService
  name: fileShareName
  properties: {
    shareQuota: 10
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: managedEnvironmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.properties.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

resource containerAppsStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = if (useAzureFilesForSqlite) {
  parent: containerAppsEnvironment
  name: environmentStorageName
  properties: {
    azureFile: {
      accountName: storageAccount!.name
      accountKey: storageAccount!.listKeys().keys[0].value
      shareName: fileShareName
      accessMode: 'ReadWrite'
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  tags: union(tags, {
    'azd-service-name': serviceName
  })
  identity: {
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: {
      '${containerAppIdentity.id}': {}
    }
  }
  dependsOn: [
    acrPullRoleAssignment
  ]
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: containerAppIdentity.id
        }
      ]
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: concat(usePostgres ? [
        {
          name: 'database-url'
          value: databaseUrl
        }
      ] : [], [
        {
          name: 'admin-password'
          value: adminPassword
        }
        {
          name: 'applicationinsights-connection-string'
          value: applicationInsights.properties.ConnectionString
        }
      ])
    }
    template: {
      // SQLite is durable on Azure Files, but should run as a single replica. PostgreSQL can scale out.
      scale: {
        minReplicas: 1
        maxReplicas: usePostgres ? 3 : 1
        rules: [
          {
            name: 'http-scale'
            http: {
              metadata: {
                concurrentRequests: '100'
              }
            }
          }
        ]
      }
      containers: [
        {
          name: serviceName
          image: placeholderImage
          env: concat([
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'ADMIN_PASSWORD'
              secretRef: 'admin-password'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              secretRef: 'applicationinsights-connection-string'
            }
          ], concat(usePostgres ? [
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
          ] : [], !usePostgres ? [
            {
              name: 'DATABASE_PATH'
              value: '${sqliteDataPath}/quiz.sqlite'
            }
          ] : []))
          volumeMounts: useAzureFilesForSqlite ? [
            {
              volumeName: environmentStorageName
              mountPath: sqliteDataPath
            }
          ] : []
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              initialDelaySeconds: 20
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 10
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      volumes: useAzureFilesForSqlite ? [
        {
          name: environmentStorageName
          storageType: 'AzureFile'
          storageName: containerAppsStorage.name
        }
      ] : []
    }
  }
}

resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, containerAppIdentity.id, 'acrpull')
  scope: containerRegistry
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
    principalId: containerAppIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output containerRegistryEndpoint string = containerRegistry.properties.loginServer
output webUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
